// The Expo face of Meta's Wearables Device Access Toolkit (iOS).
//
// UNVERIFIED: written against the DAT 1.0 public API (docs, AGENTS.md and the
// CameraAccess sample) but never compiled here — iOS builds need macOS with
// Xcode 26.4+. The Android twin (../android) is compiled against the real
// SDK; keep the two in step. See ../README.md.
//
// One session at a time, one camera stream on it. JS calls connect() (session
// + camera stream), capturePhoto() any number of times, then disconnect().
// Every state change is emitted as `onStatus` with the full status object.
import ExpoModulesCore
import Foundation
import MWDATCamera
import MWDATCore
import UIKit
#if canImport(MWDATMockDevice)
import MWDATMockDevice
#endif

/// A failure the JS side can switch on (`error.code`).
private func fail(_ code: String, _ message: String) -> Exception {
  Exception(name: "GlassesException", description: message, code: code)
}

extension AnyListenerToken {
  /// Retain the token (a released token stops listening).
  func keep(in list: inout [AnyListenerToken]) { list.append(self) }
}

/// Cancel tokens off the caller's actor (`cancel()` is asynchronous).
private func cancelTokens(_ tokens: [AnyListenerToken]) {
  guard !tokens.isEmpty else { return }
  Task { for token in tokens { await token.cancel() } }
}

/// How long a capture may take before it is abandoned.
private let captureTimeoutSeconds: UInt64 = 20
/// Long edge of saved photos: what vision models look at anyway.
private let maxEdge: CGFloat = 1568

/// `Wearables.configure()` once per process: the URL callback
/// (GlassesAppDelegateSubscriber) can arrive before the module is first used.
enum GlassesSDK {
  private(set) static var configured = false

  static func configureOnce() throws {
    if configured { return }
    try Wearables.configure()
    configured = true
  }
}

public final class GlassesModule: Module {
  private var configured = false
  private var registrationTask: Task<Void, Never>?
  private var devicesTask: Task<Void, Never>?

  private var session: DeviceSession?
  private var camera: MWDATCamera.Camera?
  // Plain arrays, not ListenerTokenBag: the bag is an actor in DAT 1.0, and
  // a token cancels when released anyway. cancelTokens() does it explicitly.
  private var sessionTokens: [AnyListenerToken] = []
  private var streamTokens: [AnyListenerToken] = []
  private var sessionState = "idle"
  private var streamState = "stopped"
  private var pendingPhoto: CheckedContinuation<PhotoData, Error>?
  /// Which capture a timeout belongs to (a later capture is not its business).
  private var captureSeq = 0

  public func definition() -> ModuleDefinition {
    Name("Glasses")
    Events("onStatus", "onError")

    Function("isSupported") { true }

    Function("getStatus") { self.status() }

    AsyncFunction("initialize") { () -> [String: Any] in
      try self.ensureConfigured()
      return self.status()
    }.runOnQueue(.main)

    AsyncFunction("register") { () async throws in
      try self.ensureConfigured()
      try await Wearables.shared.startRegistration()
    }

    AsyncFunction("unregister") { () async throws in
      try self.ensureConfigured()
      try await Wearables.shared.startUnregistration()
    }

    AsyncFunction("requestCameraPermission") { () async throws -> String in
      try self.ensureConfigured()
      if try await Wearables.shared.checkPermissionStatus(.camera) == .granted { return "granted" }
      return try await Wearables.shared.requestPermission(.camera) == .granted ? "granted" : "denied"
    }

    AsyncFunction("connect") { () async throws -> [String: Any] in
      try await self.connect()
    }

    AsyncFunction("disconnect") { () in
      self.disconnect()
    }.runOnQueue(.main)

    AsyncFunction("capturePhoto") { () async throws -> [String: Any] in
      try await self.capturePhoto()
    }

    AsyncFunction("enableMockDevice") { (usePhoneCamera: Bool) throws -> Bool in
      #if canImport(MWDATMockDevice)
      let kit = MockDeviceKit.shared
      if !kit.isEnabled { kit.enable() }
      try self.ensureConfigured()
      if kit.pairedDevices.isEmpty {
        let glasses = try kit.pairGlasses(model: .rayBanMeta)
        glasses.powerOn()
        glasses.unfold()
        glasses.don()
        if usePhoneCamera { glasses.services.camera.setCameraFeed(cameraFacing: .back) }
      }
      self.emitStatus()
      return true
      #else
      return false
      #endif
    }.runOnQueue(.main)

    AsyncFunction("disableMockDevice") { () in
      self.disconnect()
      #if canImport(MWDATMockDevice)
      MockDeviceKit.shared.disable()
      #endif
      self.emitStatus()
    }.runOnQueue(.main)

    OnDestroy {
      self.registrationTask?.cancel()
      self.devicesTask?.cancel()
      self.camera?.stop()
      self.session?.stop()
    }
  }

  // MARK: status

  private func registrationName() -> String {
    guard configured else { return "uninitialized" }
    // Only the cases Meta's sample uses are named; the rest map by name
    // ("available" → "unregistered", as on Android).
    let state = Wearables.shared.registrationState
    if state == .registered { return "registered" }
    if state == .registering { return "registering" }
    let name = "\(state)".lowercased()
    return name == "available" ? "unregistered" : name
  }

  private func status() -> [String: Any] {
    let ids = configured ? Wearables.shared.devices : []
    let names = ids.compactMap { Wearables.shared.deviceForIdentifier($0)?.nameOrId() }
    #if canImport(MWDATMockDevice)
    let mockAvailable = true
    let mockEnabled = MockDeviceKit.shared.isEnabled
    #else
    let mockAvailable = false
    let mockEnabled = false
    #endif
    return [
      "platform": "ios",
      "registration": registrationName(),
      "devices": names,
      "deviceCount": ids.count,
      "session": sessionState,
      "stream": streamState,
      "mockDevice": mockEnabled,
      "mockDeviceAvailable": mockAvailable,
    ]
  }

  private func emitStatus() {
    sendEvent("onStatus", status())
  }

  private func emitError(_ message: String) {
    sendEvent("onError", ["message": message])
  }

  // MARK: setup

  private func ensureConfigured() throws {
    if configured { return }
    do {
      try GlassesSDK.configureOnce()
    } catch {
      throw fail("ERR_GLASSES_INIT", error.localizedDescription)
    }
    configured = true
    registrationTask = Task { [weak self] in
      for await _ in Wearables.shared.registrationStateStream() {
        await MainActor.run { self?.emitStatus() }
      }
    }
    devicesTask = Task { [weak self] in
      for await _ in Wearables.shared.devicesStream() {
        await MainActor.run { self?.emitStatus() }
      }
    }
  }

  // MARK: session + camera

  private func connect() async throws -> [String: Any] {
    try await MainActor.run { try self.ensureConfigured() }
    guard Wearables.shared.registrationState == .registered else {
      throw fail("ERR_GLASSES_NOT_REGISTERED", "Connect this app to your glasses in the Meta AI app first.")
    }
    if try await Wearables.shared.checkPermissionStatus(.camera) != .granted {
      guard try await Wearables.shared.requestPermission(.camera) == .granted else {
        throw fail("ERR_GLASSES_PERMISSION_DENIED", "Camera access on the glasses was not granted.")
      }
    }
    if camera == nil {
      do {
        try await startSessionAndCamera()
      } catch {
        // Never leave a half-open session (or the capture LED) behind.
        await MainActor.run { self.teardown() }
        throw error
      }
    }
    let name = session?.device?.nameOrId() ?? "Meta glasses"
    return ["id": name, "name": name]
  }

  private func startSessionAndCamera() async throws {
    let created: DeviceSession
    do {
      created = try Wearables.shared.createSession(
        deviceSelector: AutoDeviceSelector(wearables: Wearables.shared))
    } catch {
      throw fail("ERR_GLASSES_SESSION", error.localizedDescription)
    }
    session = created
    created.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        self.sessionState = "\(state)"
        if state == .stopped { self.clearSession(created) }
        self.emitStatus()
      }
    }.keep(in: &sessionTokens)
    created.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.emitError(error.localizedDescription) }
    }.keep(in: &sessionTokens)

    do {
      try created.start()
    } catch {
      throw fail("ERR_GLASSES_SESSION", error.localizedDescription)
    }
    guard await waitFor(created.stateStream(), timeoutSeconds: 30, where: { $0 == .started || $0 == .stopped }) == .started
    else {
      created.stop()
      throw fail("ERR_GLASSES_SESSION", "The glasses did not connect. Are they on, unfolded and near the phone?")
    }

    let config = StreamConfiguration(videoCodec: .raw, resolution: .low, frameRate: 15)
    guard let added = try created.addCamera(config: config) else {
      throw fail("ERR_GLASSES_CAMERA", "Could not open the glasses camera.")
    }
    camera = added
    let stream = added.stream
    stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        self?.streamState = "\(state)"
        self?.emitStatus()
      }
    }.keep(in: &streamTokens)
    stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.emitError(error.localizedDescription) }
    }.keep(in: &streamTokens)
    stream.photoDataPublisher.listen { [weak self] photo in
      Task { @MainActor in
        self?.pendingPhoto?.resume(returning: photo)
        self?.pendingPhoto = nil
      }
    }.keep(in: &streamTokens)
    stream.start()
  }

  /// First value of `stream` matching `predicate`, or nil after the timeout.
  private func waitFor<S: AsyncSequence>(
    _ stream: S, timeoutSeconds: Double, where predicate: @escaping (S.Element) -> Bool
  ) async -> S.Element? {
    await withTaskGroup(of: S.Element?.self) { group in
      group.addTask {
        do {
          for try await value in stream where predicate(value) { return value }
        } catch {}
        return nil
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
  }

  @MainActor
  private func clearSession(_ stopped: DeviceSession) {
    guard session === stopped else { return }
    forget()
  }

  /// Drop the session and camera, release listeners, fail a pending capture.
  private func forget() {
    cancelTokens(sessionTokens + streamTokens)
    sessionTokens = []
    streamTokens = []
    camera = nil
    session = nil
    streamState = "stopped"
    failPendingPhoto("The glasses disconnected before the photo arrived.")
  }

  private func failPendingPhoto(_ message: String) {
    pendingPhoto?.resume(throwing: fail("ERR_GLASSES_CAPTURE", message))
    pendingPhoto = nil
  }

  /// Stop the camera and session and forget them; safe to call any time.
  private func teardown() {
    camera?.stop()
    session?.stop()
    forget()
    sessionState = "idle"
  }

  private func disconnect() {
    teardown()
    emitStatus()
  }

  // MARK: photos

  private func capturePhoto() async throws -> [String: Any] {
    guard let stream = camera?.stream else {
      throw fail("ERR_GLASSES_NOT_CONNECTED", "Connect to the glasses first.")
    }
    let photo: PhotoData = try await withCheckedThrowingContinuation { cont in
      Task { @MainActor in
        guard self.pendingPhoto == nil else {
          cont.resume(throwing: fail("ERR_GLASSES_CAPTURE", "A photo is already being taken."))
          return
        }
        self.pendingPhoto = cont
        self.captureSeq += 1
        let seq = self.captureSeq
        // false = the capture did not start, so no photo will arrive.
        if !stream.capturePhoto(format: .jpeg) {
          self.pendingPhoto = nil
          cont.resume(throwing: fail("ERR_GLASSES_CAPTURE", "The photo was not taken."))
          return
        }
        // A photo that never arrives must not hang the caller forever.
        Task { @MainActor [weak self] in
          try? await Task.sleep(nanoseconds: captureTimeoutSeconds * 1_000_000_000)
          guard let self, self.captureSeq == seq else { return }
          self.failPendingPhoto("The glasses did not send the photo in time.")
        }
      }
    }
    guard let original = UIImage(data: photo.data) else {
      throw fail("ERR_GLASSES_CAPTURE", "The photo could not be decoded.")
    }
    let image = downscale(original)
    guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
      throw fail("ERR_GLASSES_CAPTURE", "The photo could not be decoded.")
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("glasses", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("glasses-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
    try jpeg.write(to: file)
    return [
      "uri": file.absoluteString,
      "mimeType": "image/jpeg",
      "width": Int(image.size.width * image.scale),
      "height": Int(image.size.height * image.scale),
    ]
  }

  private func downscale(_ image: UIImage) -> UIImage {
    let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    let long = max(size.width, size.height)
    guard long > maxEdge else { return image }
    let factor = maxEdge / long
    let target = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: target))
    }
  }
}
