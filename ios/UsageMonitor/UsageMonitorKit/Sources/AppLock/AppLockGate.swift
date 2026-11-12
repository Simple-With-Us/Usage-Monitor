import SwiftUI
import AppCore
import DesignSystem

/// Face ID / Touch ID / passcode app-lock gate — owned by the **AppLock** lane.
///
/// Wraps arbitrary content (the app target wraps `RootView` in it) and, when the
/// user has enabled the lock in Settings, requires `LocalAuthentication` before
/// revealing that content. The signature stays `AppLockGate { <content> }` per
/// the architecture contract.
///
/// Behavior:
///   - **Disabled** → pure pass-through; content renders directly.
///   - **Enabled** → starts locked, prompts on launch and on every return from
///     the background, and re-locks when the app leaves the foreground.
///   - **App-switcher privacy** → whenever the app is not `.active` the content
///     is hidden behind an opaque cover so the multitasking snapshot can't leak
///     spending data.
///   - **Graceful fallback** → uses `.deviceOwnerAuthentication`, so a biometric
///     failure falls back to the device passcode automatically; a device with no
///     authentication configured fails open rather than trapping the user.
///
/// The `NSFaceIDUsageDescription` Info.plist key is provided by the app target.
public struct AppLockGate<Content: View>: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller: AppLockController
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
        _controller = State(initialValue: AppLockController())
    }

    /// Test / preview seam: inject a controller with a stub authenticator.
    init(controller: AppLockController, @ViewBuilder content: () -> Content) {
        self.content = content()
        _controller = State(initialValue: controller)
    }

    public var body: some View {
        let enabled = env.settings.appLockEnabled
        let covered = isCovered(enabled: enabled)

        ZStack {
            content
                .accessibilityHidden(covered)
                .allowsHitTesting(!covered)

            if covered {
                LockScreenView(
                    availability: controller.availability(),
                    phase: controller.phase,
                    showsControls: showsControls,
                    onUnlock: { Task { await controller.retry() } }
                )
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: covered)
        .animation(.easeInOut(duration: 0.2), value: controller.phase)
        // Runs on appear and whenever the Settings toggle flips.
        .task(id: enabled) {
            controller.syncEnabled(enabled)
            await controller.unlockIfNeeded(enabled: enabled)
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .background:
                controller.lock(enabled: enabled)
            case .active:
                Task { await controller.unlockIfNeeded(enabled: enabled) }
            case .inactive:
                break            // transient (prompt / Control Center); cover stays
            @unknown default:
                break
            }
        }
    }

    /// The content is covered while the lock is enabled and either the gate is
    /// not unlocked or the app is not front-and-active (app-switcher privacy).
    private func isCovered(enabled: Bool) -> Bool {
        guard enabled else { return false }
        return !controller.phase.isUnlocked || scenePhase != .active
    }

    /// Interactive controls (the Unlock button + error copy) appear only when
    /// the app is active and actually locked — not during a passing privacy
    /// cover or while a system prompt is in flight.
    private var showsControls: Bool {
        scenePhase == .active && !controller.phase.isUnlocked && controller.phase != .authenticating
    }
}
