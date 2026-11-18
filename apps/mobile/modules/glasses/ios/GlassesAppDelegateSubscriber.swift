// Meta AI returns to the app on its URL scheme after registration and
// permission prompts, tagged with a `metaWearablesAction` query item. Those
// URLs belong to the SDK: hand them over and claim them (return true) so the
// router does not also try to navigate to them. Every other URL passes by.
// UNVERIFIED on device (see GlassesModule.swift).
import ExpoModulesCore
import MWDATCore

public class GlassesAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
    else { return false }
    Task {
      do {
        try GlassesSDK.configureOnce()
        _ = try await Wearables.shared.handleUrl(url)
      } catch {
        NSLog("[glasses] handleUrl failed: \(error)")
      }
    }
    return true
  }
}
