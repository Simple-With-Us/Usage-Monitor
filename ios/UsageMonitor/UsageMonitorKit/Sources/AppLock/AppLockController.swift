import Foundation
import Observation

/// The AppLock state machine. Owns the lock/unlock lifecycle and drives the
/// biometric prompt through an injected `AppLockAuthenticator`. Deliberately
/// free of any SwiftUI / LocalAuthentication import so it is unit-testable with
/// a stub authenticator; the `AppLockGate` view feeds it scene-phase events.
///
/// Design decisions:
///   - **Fail-closed default.** Starts `.locked` so content is never shown
///     before authentication when the feature is enabled.
///   - **Fail-open on `.unavailable`.** If the device can't evaluate any policy
///     (no passcode / no biometrics), we unlock rather than trap the user out
///     of a read-only monitor. The lock is only as strong as the device allows.
///   - **No re-prompt loop.** Automatic prompts fire only from `.locked`. A
///     `.failed` state (e.g. the user canceled Face ID) waits for an explicit
///     `retry()` tap instead of immediately re-presenting the system sheet.
@MainActor
@Observable
public final class AppLockController {
    /// The gate's current state. The view renders a cover unless `.unlocked`.
    public enum Phase: Equatable, Sendable {
        /// Content is visible.
        case unlocked
        /// Locked and awaiting an authentication attempt.
        case locked
        /// A system authentication prompt is in flight.
        case authenticating
        /// The last attempt failed; awaits a user-initiated `retry()`.
        case failed(AppLockError)

        public var isUnlocked: Bool { self == .unlocked }
    }

    public private(set) var phase: Phase

    private let authenticator: AppLockAuthenticator
    private let reason: String

    /// - Parameters:
    ///   - authenticator: the biometric backend (defaults to the real one).
    ///   - reason: localized reason shown in the system prompt.
    ///   - initialPhase: starting state; `.locked` (fail-closed) in production.
    public init(
        authenticator: AppLockAuthenticator = BiometricAuthenticator(),
        reason: String? = nil,
        initialPhase: Phase = .locked
    ) {
        self.authenticator = authenticator
        // Plain app name from the host target's CFBundleDisplayName
        // (Usage Monitor Client / Usage Monitor Local).
        let name = AppProductName.displayName
        self.reason = reason ?? "Unlock \(name) to view your spending."
        self.phase = initialPhase
    }

    /// What the device can offer, for choosing the lock-screen glyph / label.
    public func availability() -> AppLockAvailability { authenticator.availability() }

    /// Reflect the Settings toggle. Turning the feature **off** unlocks
    /// immediately; turning it **on** never force-locks an app the user is
    /// already looking at — that takes effect on the next background/resume.
    public func syncEnabled(_ enabled: Bool) {
        if !enabled { phase = .unlocked }
    }

    /// Called on appear and on returning to the foreground. Auto-prompts only
    /// from a fresh `.locked` state; a `.failed` state is left for the user to
    /// retry so we never loop the system sheet after a cancel.
    public func unlockIfNeeded(enabled: Bool) async {
        guard enabled else { phase = .unlocked; return }
        if case .locked = phase { await authenticate() }
    }

    /// User tapped the unlock control on the lock screen.
    public func retry() async {
        guard phase != .authenticating else { return }
        await authenticate()
    }

    /// The app resigned active / entered the background. Re-lock so returning
    /// requires authentication again. A `.failed` state is reset to a fresh
    /// `.locked` so the next resume re-prompts cleanly. An in-flight prompt is
    /// left alone (presenting biometrics can transiently background the app).
    public func lock(enabled: Bool) {
        guard enabled else { return }
        if phase != .authenticating { phase = .locked }
    }

    private func authenticate() async {
        phase = .authenticating
        switch await authenticator.evaluate(reason: reason) {
        case .success:
            phase = .unlocked
        case .failure(.unavailable):
            // Device can't enforce a lock — fail open rather than trap the user.
            phase = .unlocked
        case .failure(let error):
            phase = .failed(error)
        }
    }
}
