import SwiftUI
import DesignSystem

/// The full-screen, fully opaque cover shown while the app is locked. Built
/// entirely from DesignSystem tokens so it reads as the same native product in
/// light and dark mode. Opacity matters for privacy: an opaque cover keeps the
/// app-switcher snapshot from revealing spending data.
///
/// Public so LocalDataPlane's `LocalAppLockGate` can reuse the same cover
/// without a remote `APIClient` / `AppEnvironment`.
public struct LockScreenView: View {
    public let availability: AppLockAvailability
    public let phase: AppLockController.Phase
    /// When `false`, this is a passive privacy cover (e.g. app-switcher / an
    /// in-flight prompt) with no interactive controls or error copy.
    public let showsControls: Bool
    public let onUnlock: () -> Void

    public init(
        availability: AppLockAvailability,
        phase: AppLockController.Phase,
        showsControls: Bool,
        onUnlock: @escaping () -> Void
    ) {
        self.availability = availability
        self.phase = phase
        self.showsControls = showsControls
        self.onUnlock = onUnlock
    }

    @ScaledMetric(relativeTo: .largeTitle) private var glyphSize: CGFloat = 52

    public var body: some View {
        ZStack {
            // Opaque base + a soft accent glow keeps content underneath hidden.
            Theme.Colors.background.ignoresSafeArea()
            RadialGradient(
                colors: [Theme.Colors.accent.opacity(0.16), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 340
            )
            .ignoresSafeArea()

            VStack(spacing: Theme.Spacing.xl) {
                Spacer()
                glyph
                textBlock
                Spacer()
                if showsControls { controls }
            }
            .padding(.horizontal, Theme.Spacing.xl)
            .padding(.vertical, Theme.Spacing.xxl)
            .frame(maxWidth: 480)
        }
        .sensoryFeedback(.error, trigger: isFailed)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    // MARK: - Pieces

    @ViewBuilder private var glyph: some View {
        ZStack {
            Circle()
                .fill(Theme.Colors.accentSoft)
                .frame(width: glyphSize * 2.1, height: glyphSize * 2.1)
            if isAuthenticating {
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.Colors.accent)
            } else {
                Image(safeSystemName: glyphSymbol, fallback: "lock.fill")
                    .font(.system(size: glyphSize, weight: .regular))
                    .foregroundStyle(glyphTint)
                    .symbolRenderingMode(.hierarchical)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isAuthenticating)
    }

    private var textBlock: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text(AppProductName.displayName)
                .font(Theme.Typography.title)
                .foregroundStyle(Theme.Colors.primaryText)
            // Suppressed in the passive privacy-cover state (unlocked but the
            // app isn't active) so the app-switcher snapshot stays clean.
            if phase != .unlocked {
                Text(statusMessage)
                    .font(Theme.Typography.callout)
                    .foregroundStyle(isFailed ? Theme.Colors.danger : Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                    .transaction { $0.animation = nil } // avoid text cross-fade jitter
            }
        }
    }

    @ViewBuilder private var controls: some View {
        Button(action: onUnlock) {
            HStack(spacing: Theme.Spacing.sm) {
                Image(safeSystemName: availability.symbolName, fallback: "lock.fill")
                Text(unlockTitle)
            }
            .font(Theme.Typography.body.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.md)
        }
        .foregroundStyle(.white)
        .background(Theme.Colors.accent, in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        .disabled(isAuthenticating)
        .opacity(isAuthenticating ? 0.6 : 1)
    }

    // MARK: - Derived state

    private var isAuthenticating: Bool { phase == .authenticating }

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private var glyphSymbol: String {
        isFailed ? "lock.trianglebadge.exclamationmark.fill" : availability.symbolName
    }

    private var glyphTint: Color {
        isFailed ? Theme.Colors.danger : Theme.Colors.accent
    }

    private var statusMessage: String {
        switch phase {
        case .unlocked:        return "Unlocked"
        case .locked:          return "Locked for your privacy."
        case .authenticating:  return "Authenticating…"
        case .failed(let error): return error.message
        }
    }

    private var unlockTitle: String {
        if case .available(let biometry) = availability { return biometry.unlockLabel }
        return "Unlock"
    }
}

#Preview("Locked") {
    LockScreenView(
        availability: .available(.faceID),
        phase: .locked,
        showsControls: true,
        onUnlock: {}
    )
}

#Preview("Failed") {
    LockScreenView(
        availability: .available(.touchID),
        phase: .failed(.failed),
        showsControls: true,
        onUnlock: {}
    )
}
