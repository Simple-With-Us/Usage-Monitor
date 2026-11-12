import Foundation
import UserNotifications

/// `UNUserNotificationCenterDelegate` that (a) lets alert notifications present
/// while the app is foregrounded and (b) forwards a tapped notification's
/// deep link to the `PushRouter`.
///
/// Kept as a distinct `NSObject` (rather than folding the protocol onto the
/// `@Observable` router) so the Observation macro and `NSObject` conformance do
/// not have to coexist. Holds the router weakly to avoid a retain cycle — the
/// router retains this delegate.
public final class PushNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    private weak var router: PushRouter?

    public init(router: PushRouter) {
        self.router = router
        super.init()
    }

    /// Show alert banners even when the app is in the foreground.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    /// A notification (or its action) was tapped — route it.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let link = PushDeepLink(userInfo: userInfo) else { return }
        await router?.handle(link)
    }
}
