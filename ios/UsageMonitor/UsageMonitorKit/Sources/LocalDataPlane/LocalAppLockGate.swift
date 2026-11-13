import SwiftUI
import AppCore
import AppLock
import DesignSystem

/// Face ID / passcode gate for Usage Monitor Local without a remote `APIClient`.
/// Uses the same `AppLockController` stack as the remote app.
public struct LocalAppLockGate<Content: View>: View {
    @Bindable var settings: AppSettings
    @Environment(\.scenePhase) private var scenePhase
    @State private var controller = AppLockController()
    private let content: Content

    public init(settings: AppSettings, @ViewBuilder content: () -> Content) {
        self.settings = settings
        self.content = content()
    }

    public var body: some View {
        let enabled = settings.appLockEnabled
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
                break
            @unknown default:
                break
            }
        }
    }

    private func isCovered(enabled: Bool) -> Bool {
        guard enabled else { return false }
        return !controller.phase.isUnlocked || scenePhase != .active
    }

    private var showsControls: Bool {
        scenePhase == .active && !controller.phase.isUnlocked && controller.phase != .authenticating
    }
}
