import Foundation
import Networking

extension Notification.Name {
    static let usageMonitorAccountDidChange = Notification.Name(
        "services.jays.usage.monitor.account-did-change"
    )
}

/// Wraps secure token persistence with an in-process lifecycle signal. The
/// notification carries no token or account metadata; it only tells the app
/// shell to recompute its opaque account scope and clear old notifications.
struct AccountChangeNotifyingTokenStore: TokenStoring {
    private let underlying: any TokenStoring
    private let notificationCenter: NotificationCenter

    init(
        underlying: any TokenStoring = KeychainTokenStore(),
        notificationCenter: NotificationCenter = .default
    ) {
        self.underlying = underlying
        self.notificationCenter = notificationCenter
    }

    func token() -> String? {
        underlying.token()
    }

    func setToken(_ token: String?) throws {
        try underlying.setToken(token)
        notificationCenter.post(name: .usageMonitorAccountDidChange, object: nil)
    }
}
