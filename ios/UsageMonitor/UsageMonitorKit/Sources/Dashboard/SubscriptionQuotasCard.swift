import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Overview card answering "how much of my subscription do I have left?"
/// for the five providers the fleet tracks quota windows for — Claude,
/// Codex, Antigravity, Grok, MiniMax. One section per provider (lowest
/// remaining first, so the most urgent quota is always on top), each window
/// shown as its label, remaining percent, a meter tinted by server status,
/// and a reset countdown. A provider with no windows yet still gets an
/// honest "No quota report yet" row instead of being silently omitted —
/// never demo numbers.
public struct SubscriptionQuotasCard: View {
    @Bindable var store: QuotaWindowsStore
    var onOpenSettings: (() -> Void)?
    var now: Date

    public init(
        store: QuotaWindowsStore,
        onOpenSettings: (() -> Void)? = nil,
        now: Date = Date()
    ) {
        self.store = store
        self.onOpenSettings = onOpenSettings
        self.now = now
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Subscription Quotas",
                subtitle: "Claude · Codex · Antigravity · Grok · MiniMax"
            )

            if store.requiresSession {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Sign in with the dashboard password in Settings to load subscription quotas.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    if let onOpenSettings {
                        Button("Open Settings", action: onOpenSettings)
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.Colors.accent)
                    }
                }
            } else if let response = store.response {
                sections(for: response)
            } else if store.state.isInitialLoading {
                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(0..<3, id: \.self) { _ in
                        SkeletonBlock(height: 44, radius: Theme.Radius.sm)
                    }
                }
            } else if store.state.error != nil {
                Text("Unable to load subscription quotas right now.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    @ViewBuilder
    private func sections(for response: QuotaWindowsResponse) -> some View {
        let sections = response.subscriptionSections
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                ProviderQuotaRows(section: section, now: now)
                if index < sections.count - 1 {
                    Divider()
                }
            }
        }
    }
}

/// One provider's rows: its display name, then a meter per quota window (or
/// the honest empty-state line when the server hasn't reported one yet).
private struct ProviderQuotaRows: View {
    let section: SubscriptionQuotaSection
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(section.provider.displayName)
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(Theme.Colors.primaryText)

            if section.windows.isEmpty {
                Text("No quota report yet")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            } else {
                ForEach(section.windows) { window in
                    QuotaWindowRow(window: window, now: now)
                }
            }
        }
    }
}

/// A single quota window: label, remaining percent, a tinted meter, and a
/// reset countdown with the device-local absolute time as secondary text
/// (product UI stays device-local per the fleet timestamp exception).
private struct QuotaWindowRow: View {
    let window: QuotaWindow
    let now: Date

    private static let absoluteTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private var remainingFraction: Double {
        min(max(window.displayRemainingPercent / 100, 0), 1)
    }

    private var countdownText: String {
        let label = QuotaCountdownFormat.label(resetAt: window.resetAtDate, now: now)
        guard let resetDate = window.resetAtDate else { return label }
        return "\(label) · \(Self.absoluteTimeFormatter.string(from: resetDate))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(window.label)
                        .font(Theme.Typography.caption.weight(.medium))
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(1)
                    if window.via?.lowercased() == "antigravity" {
                        Text("via Antigravity")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                    }
                }
                Spacer(minLength: Theme.Spacing.sm)
                Text(CurrencyFormat.percent(remainingFraction))
                    .font(Theme.Typography.captionEmphasis)
                    .monospacedDigit()
                    .foregroundStyle(window.status.semanticStatus.tint)
            }
            BudgetMeter(fraction: remainingFraction, status: window.status.semanticStatus, height: 6)
            Text(countdownText)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(window.label). \(CurrencyFormat.percent(remainingFraction)) remaining. \(countdownText)."
        )
    }
}

// MARK: - Status mapping

extension QuotaWindowStatus {
    /// Maps the server's quota status onto the design system's tint scale.
    /// `.available` is ok/green, `.nearCap` (≤20%) is warning/amber,
    /// `.exhausted` is danger/red, and an unrecognized future status is
    /// neutral rather than alarming.
    var semanticStatus: Theme.SemanticStatus {
        switch self {
        case .available: return .ok
        case .nearCap: return .warning
        case .exhausted: return .danger
        case .unknown: return .neutral
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Subscription Quotas — loaded", traits: .sizeThatFitsLayout) {
    let (store, client) = DashboardPreview.quotaWindowsStore(.sample)
    return ScrollView {
        SubscriptionQuotasCard(
            store: store,
            now: ISO8601DateParser.date(from: "2026-09-12T18:00:00.000Z") ?? Date()
        )
        .padding()
    }
    .background(Theme.Colors.background)
    .task { await store.loadIfNeeded(using: client) }
}

#Preview("Subscription Quotas — empty", traits: .sizeThatFitsLayout) {
    let (store, client) = DashboardPreview.quotaWindowsStore(QuotaWindowsResponse(ok: true, windows: []))
    return ScrollView {
        SubscriptionQuotasCard(store: store)
            .padding()
    }
    .background(Theme.Colors.background)
    .task { await store.loadIfNeeded(using: client) }
}
#endif
