package expo.modules.glasses

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.exifinterface.media.ExifInterface
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** A failure the JS side can switch on (`error.code`). */
private class GlassesException(code: String, message: String) : CodedException(code, message, null)

/**
 * The Expo face of Meta's Wearables Device Access Toolkit (Android).
 *
 * One session at a time, one camera stream on it. JS calls connect() (session
 * + camera stream), capturePhoto() any number of times, then disconnect().
 * Every state change is emitted as `onStatus` with the full status object, so
 * the JS side never has to reconcile partial updates.
 */
class GlassesModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var initialized = false
  private var watchers: List<Job> = emptyList()

  private var session: DeviceSession? = null
  private var camera: Camera? = null
  private var sessionJobs: List<Job> = emptyList()

  private var sessionState = "idle"
  private var streamState = "stopped"

  private val context: Context
    get() = appContext.reactContext ?: throw GlassesException("ERR_GLASSES_NO_CONTEXT", "No Android context.")

  override fun definition() = ModuleDefinition {
    Name("Glasses")
    Events("onStatus", "onError")

    Function("isSupported") { true }

    Function("getStatus") { status() }

    /** Bluetooth permission, then Wearables.initialize. Idempotent. */
    AsyncFunction("initialize") Coroutine { ->
      ensureInitialized()
      status()
    }

    /** Opens the Meta AI app to link this app to the glasses. */
    AsyncFunction("register") Coroutine { ->
      ensureInitialized()
      Wearables.startRegistration(requireActivity())
    }

    AsyncFunction("unregister") Coroutine { ->
      ensureInitialized()
      Wearables.startUnregistration(requireActivity())
    }

    /** "granted" | "denied". May switch to the Meta AI app to ask. */
    AsyncFunction("requestCameraPermission") Coroutine { ->
      ensureInitialized()
      if (cameraPermissionGranted()) "granted" else requestCameraPermission()
    }

    AsyncFunction("connect") Coroutine { -> connect() }

    AsyncFunction("disconnect") Coroutine { -> disconnect() }

    AsyncFunction("capturePhoto") Coroutine { -> capturePhoto() }

    /** Simulated glasses (MockDeviceKit). False when it is not compiled in. */
    AsyncFunction("enableMockDevice") Coroutine { usePhoneCamera: Boolean ->
      if (!MockSupport.AVAILABLE) return@Coroutine false
      ensureAndroidPermissions(if (usePhoneCamera) listOf(Manifest.permission.CAMERA) else emptyList())
      // Initialise first: MockDeviceKit initialises Wearables itself when it
      // is not yet, and a second Wearables.initialize would then fail.
      ensureInitialized()
      MockSupport.enable(context, usePhoneCamera)
      emitStatus()
      true
    }

    AsyncFunction("disableMockDevice") Coroutine { ->
      disconnect()
      MockSupport.disable(context)
      emitStatus()
    }

    // Meta AI calls back on the app's scheme with ?metaWearablesAction=…
    // (registration it started itself). Hand those intents to the SDK.
    OnNewIntent { intent -> handleIntent(intent) }

    OnDestroy {
      scope.cancel()
      camera?.stop()
      session?.stop()
    }
  }

  // ── status ──────────────────────────────────────────────────────────────

  private fun registrationName(): String =
    if (!initialized) "uninitialized"
    else when (Wearables.registrationState.value) {
      RegistrationState.REGISTERED -> "registered"
      RegistrationState.REGISTERING -> "registering"
      RegistrationState.UNREGISTERING -> "unregistering"
      RegistrationState.AVAILABLE -> "unregistered"
      RegistrationState.UNAVAILABLE -> "unavailable"
      else -> "unknown"
    }

  private fun status(): Map<String, Any?> {
    val devices = if (initialized) Wearables.devices.value else emptySet()
    val names = devices.mapNotNull { Wearables.devicesMetadata[it]?.value?.name?.ifEmpty { null } }
    return mapOf(
      "platform" to "android",
      "registration" to registrationName(),
      "devices" to names,
      "deviceCount" to devices.size,
      "session" to sessionState,
      "stream" to streamState,
      "mockDevice" to MockSupport.isEnabled(appContext.reactContext),
      "mockDeviceAvailable" to MockSupport.AVAILABLE,
    )
  }

  private fun emitStatus() = sendEvent("onStatus", status())

  private fun emitError(message: String) = sendEvent("onError", mapOf("message" to message))

  // ── setup ───────────────────────────────────────────────────────────────

  private fun requireActivity(): Activity =
    appContext.currentActivity ?: throw GlassesException("ERR_GLASSES_NO_ACTIVITY", "The app is not in the foreground.")

  private suspend fun ensureAndroidPermissions(extra: List<String> = emptyList()) {
    val needed = buildList {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_CONNECT)
      addAll(extra)
    }
    if (needed.isEmpty()) return
    val permissions = appContext.permissions
      ?: throw GlassesException("ERR_GLASSES_PERMISSIONS", "Permissions module unavailable.")
    val result: Map<String, PermissionsResponse> = suspendCancellableCoroutine { cont ->
      permissions.askForPermissions({ res -> cont.resume(res) }, *needed.toTypedArray())
    }
    val denied = result.filterValues { it.status != PermissionsStatus.GRANTED }.keys
    if (denied.isNotEmpty()) {
      throw GlassesException("ERR_GLASSES_PERMISSION_DENIED", "Permission denied: ${denied.joinToString()}")
    }
  }

  private suspend fun ensureInitialized() {
    if (initialized) return
    ensureAndroidPermissions()
    var failure: String? = null
    Wearables.initialize(context).onFailure { error, _ -> failure = error.description }
    failure?.let { throw GlassesException("ERR_GLASSES_INIT", it) }
    initialized = true
    watchers = listOf(
      scope.launch { Wearables.registrationState.collect { emitStatus() } },
      scope.launch { Wearables.devices.collect { emitStatus() } },
      scope.launch { Wearables.registrationErrorStream.collect { emitError(it.description) } },
    )
  }

  private fun handleIntent(intent: Intent) {
    if (!initialized || intent.data?.getQueryParameter("metaWearablesAction") == null) return
    Wearables.handleIntent(intent) { request ->
      appContext.currentActivity?.let { request.continueRegistration(it) }
    }.onFailure { error, _ -> emitError(error.description) }
  }

  // ── permissions on the glasses (granted in the Meta AI app) ─────────────

  private suspend fun cameraPermissionGranted(): Boolean {
    var granted = false
    Wearables.checkPermissionStatus(Permission.CAMERA)
      .onSuccess { granted = it == PermissionStatus.Granted }
      .onFailure { error, _ -> throw GlassesException("ERR_GLASSES_PERMISSION", error.description) }
    return granted
  }

  private suspend fun requestCameraPermission(): String {
    val activity = requireActivity() as? ComponentActivity
      ?: throw GlassesException("ERR_GLASSES_NO_ACTIVITY", "The current activity cannot request permissions.")
    return suspendCancellableCoroutine { cont ->
      val key = "glasses-camera-${UUID.randomUUID()}"
      var launcher: androidx.activity.result.ActivityResultLauncher<Permission>? = null
      launcher = activity.activityResultRegistry.register(key, Wearables.RequestPermissionContract()) { result ->
        launcher?.unregister()
        val status = result.getOrDefault(PermissionStatus.Denied)
        if (cont.isActive) cont.resume(if (status == PermissionStatus.Granted) "granted" else "denied")
      }
      cont.invokeOnCancellation { launcher.unregister() }
      launcher.launch(Permission.CAMERA)
    }
  }

  // ── session + camera ────────────────────────────────────────────────────

  private suspend fun connect(): Map<String, Any?> {
    ensureInitialized()
    if (Wearables.registrationState.value != RegistrationState.REGISTERED) {
      throw GlassesException("ERR_GLASSES_NOT_REGISTERED", "Connect this app to your glasses in the Meta AI app first.")
    }
    if (!cameraPermissionGranted() && requestCameraPermission() != "granted") {
      throw GlassesException("ERR_GLASSES_PERMISSION_DENIED", "Camera access on the glasses was not granted.")
    }
    if (camera == null) {
      try {
        startSessionAndCamera()
      } catch (e: Exception) {
        // Never leave a half-open session (or the capture LED) behind.
        teardown()
        throw e
      }
    }
    val name = session?.deviceInfo?.value?.name?.ifEmpty { null } ?: "Meta glasses"
    return mapOf("id" to name, "name" to name)
  }

  private suspend fun startSessionAndCamera() {
    var createError: String? = null
    val created = Wearables.createSession(AutoDeviceSelector())
      .fold({ it }, { error, _ -> createError = error.description; null })
      ?: throw GlassesException("ERR_GLASSES_SESSION", createError ?: "Could not create a session.")
    session = created
    sessionJobs = listOf(
      scope.launch {
        created.state.collect {
          sessionState = it.name.lowercase()
          if (it == DeviceSessionState.STOPPED) clearSession(created)
          emitStatus()
        }
      },
      scope.launch { created.errors.collect { emitError(it.description) } },
    )
    created.start()
    val started = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
      created.state.first { it == DeviceSessionState.STARTED || it == DeviceSessionState.STOPPED }
    }
    if (started != DeviceSessionState.STARTED) {
      created.stop()
      throw GlassesException(
        "ERR_GLASSES_SESSION",
        "The glasses did not connect. Are they on, unfolded and near the phone?",
      )
    }

    var cameraError: String? = null
    val added = created.addCamera(StreamConfiguration(videoQuality = VideoQuality.MEDIUM, frameRate = 15))
      .fold({ it }, { error, _ -> cameraError = error.description; null })
      ?: throw GlassesException("ERR_GLASSES_CAMERA", cameraError ?: "Could not open the glasses camera.")
    camera = added
    val stream = added.stream
    sessionJobs = sessionJobs + listOf(
      scope.launch {
        stream.state.collect {
          streamState = it.name.lowercase()
          emitStatus()
        }
      },
      scope.launch { stream.errorStream.collect { emitError(it.description) } },
    )
    var startError: String? = null
    stream.start().onFailure { error, _ -> startError = error.description }
    startError?.let { throw GlassesException("ERR_GLASSES_CAMERA", it) }
    val streaming = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
      stream.state.first { it == StreamState.STREAMING || it == StreamState.CLOSED }
    }
    if (streaming != StreamState.STREAMING) {
      throw GlassesException("ERR_GLASSES_CAMERA", "The glasses camera did not start streaming.")
    }
  }

  private fun clearSession(stopped: DeviceSession) {
    if (session !== stopped) return
    sessionJobs.forEach { it.cancel() }
    sessionJobs = emptyList()
    camera = null
    session = null
    streamState = "stopped"
  }

  /** Stop the camera and session and forget them; safe to call any time. */
  private fun teardown() {
    camera?.stop()
    session?.stop()
    session?.let { clearSession(it) }
    camera = null
    session = null
    sessionState = "idle"
    streamState = "stopped"
  }

  private fun disconnect() {
    teardown()
    emitStatus()
  }

  // ── photos ──────────────────────────────────────────────────────────────

  private suspend fun capturePhoto(): Map<String, Any?> {
    val stream = camera?.stream
      ?: throw GlassesException("ERR_GLASSES_NOT_CONNECTED", "Connect to the glasses first.")
    var captureError: String? = null
    val photo = stream.capturePhoto().fold({ it }, { error, _ -> captureError = error.description; null })
      ?: throw GlassesException("ERR_GLASSES_CAPTURE", captureError ?: "The photo was not taken.")
    return withContext(Dispatchers.IO) {
      val decoded = when (photo) {
        is PhotoData.Bitmap -> photo.bitmap
        is PhotoData.HEIC -> decodeHeic(photo.data)
      } ?: throw GlassesException("ERR_GLASSES_CAPTURE", "The photo could not be decoded.")
      val bitmap = downscale(decoded)
      val dir = File(context.cacheDir, "glasses").apply { mkdirs() }
      val file = File(dir, "glasses-${System.currentTimeMillis()}.jpg")
      FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
      mapOf(
        "uri" to "file://${file.absolutePath}",
        "mimeType" to "image/jpeg",
        "width" to bitmap.width,
        "height" to bitmap.height,
      )
    }
  }

  /**
   * At most MAX_EDGE px on the long edge: what vision models look at anyway
   * (Anthropic downsizes beyond ~1568 px), and a fraction of the upload.
   */
  private fun downscale(bitmap: Bitmap): Bitmap {
    val long = maxOf(bitmap.width, bitmap.height)
    if (long <= MAX_EDGE) return bitmap
    val scale = MAX_EDGE.toFloat() / long
    return Bitmap.createScaledBitmap(
      bitmap,
      (bitmap.width * scale).toInt().coerceAtLeast(1),
      (bitmap.height * scale).toInt().coerceAtLeast(1),
      true,
    )
  }

  /** HEIC from the glasses carries its orientation in EXIF; apply it. */
  private fun decodeHeic(buffer: java.nio.ByteBuffer): Bitmap? {
    val bytes = ByteArray(buffer.remaining()).also { buffer.duplicate().get(it) }
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    val degrees = try {
      ExifInterface(ByteArrayInputStream(bytes)).rotationDegrees
    } catch (e: Exception) {
      Log.w(TAG, "No EXIF orientation", e)
      0
    }
    if (degrees == 0) return bitmap
    val matrix = Matrix().apply { postRotate(degrees.toFloat()) }
    return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
  }

  private companion object {
    const val TAG = "Glasses"
    const val CONNECT_TIMEOUT_MS = 30_000L
    const val JPEG_QUALITY = 80
    const val MAX_EDGE = 1568
  }
}
