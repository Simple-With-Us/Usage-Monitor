import SwiftUI
import DesignSystem
import Networking

/// The one shared "couldn't load budget data" state, used by every data lane
/// (Dashboard, Providers, Alerts, Projects) so the same failure always looks
/// and behaves identically — same symbol, same copy, same next step.
///
/// Crucially, it turns the previously dead-end configuration errors into an
/// actionable path: `missingToken` / `unauthorized` render a prominent
/// "Connect your monitor" / "Open Settings" button that jumps straight to the
/// Settings tab via ``AppEnvironment/selectTab``, instead of leaving a first-run
/// user staring at "No API token" with no way forward.
public struct BudgetErrorState: View {
    private let error: APIError
    private let onRetry: (() -> Void)?
    private let onConnect: (() -> Void)?

    /// - Parameters:
    ///   - error: the typed failure to present.
    ///   - onRetry: invoked by the "Try again" button (only shown when the error
    ///     is retryable). Usually a pull/refresh.
    ///   - onConnect: invoked by the "Connect your monitor" / "Open Settings"
    ///     button for configuration errors. Usually `env.selectTab?(.settings)`.
    public init(
        error: APIError,
        onRetry: (() -> Void)? = nil,
        onConnect: (() -> Void)? = nil
    ) {
        self.error = error
        self.onRetry = onRetry
        self.onConnect = onConnect
    }

    public var body: some View {
        ErrorState(
            systemImage: Self.symbol(for: error),
            title: error.title,
            message: error.message,
            actionTitle: connectTitle,
            actionSystemImage: "gearshape.fill",
            action: connectTitle == nil ? nil : onConnect,
            retryTitle: error.isRetryable ? "Try Again" : nil,
            retry: error.isRetryable ? onRetry : nil
        )
    }

    /// The prominent CTA label for configuration errors the user can fix in
    /// Settings, or `nil` when there's nothing actionable there.
    private var connectTitle: String? {
        switch error {
        case .missingToken: return "Connect your monitor"
        case .unauthorized: return "Open Settings"
        default: return nil
        }
    }

    /// A consistent SF Symbol per failure, shared across all four data tabs so
    /// the same condition never reads as a different problem tab-to-tab.
    public static func symbol(for error: APIError) -> String {
        switch error {
        case .missingToken: return "key.horizontal.fill"
        case .unauthorized, .forbidden: return "lock.trianglebadge.exclamationmark.fill"
        case .offline: return "wifi.slash"
        case .serverNotConfigured: return "exclamationmark.icloud.fill"
        case .rateLimited: return "hourglass"
        default: return "exclamationmark.triangle.fill"
        }
    }
}
