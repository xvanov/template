package expo.modules.glasses

import android.content.Context
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockDeviceKitConfig
import com.meta.wearable.dat.mockdevice.api.camera.CameraFacing

/**
 * MockDeviceKit: simulated Ray-Ban Meta glasses, registered and with camera
 * permission granted, powered on, unfolded and worn. With `usePhoneCamera`
 * the phone's back camera is the glasses' camera feed, so the whole
 * connect → stream → capture path runs through the real SDK without hardware.
 * Compiled only when gradle.properties has glasses.mockDevice=true.
 */
internal object MockSupport {
  const val AVAILABLE = true

  fun isEnabled(context: Context?): Boolean =
    context != null && MockDeviceKit.getInstance(context).isEnabled

  fun enable(context: Context, usePhoneCamera: Boolean) {
    val kit = MockDeviceKit.getInstance(context)
    if (!kit.isEnabled) {
      kit.enable(MockDeviceKitConfig(initiallyRegistered = true, initialPermissionsGranted = true))
    }
    if (kit.pairedDevices.isNotEmpty()) return
    var failure: String? = null
    val glasses = kit.pairGlasses(GlassesModel.RAYBAN_META)
      .fold({ it }, { error, _ -> failure = error.description; null })
      ?: throw IllegalStateException(failure ?: "MockDeviceKit could not pair glasses.")
    glasses.powerOn()
    glasses.unfold()
    glasses.don()
    if (usePhoneCamera) glasses.services.camera.setCameraFeed(CameraFacing.BACK)
  }

  fun disable(context: Context) {
    MockDeviceKit.getInstance(context).disable()
  }
}
