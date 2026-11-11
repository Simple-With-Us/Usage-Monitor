import SwiftUI
import Models
import AppCore
import DesignSystem
import Networking

// ---------------------------------------------------------------------------
// Alerts-lane presentation pieces, built entirely from DesignSystem tokens and
// the domain→status bridge (`Theme.SemanticStatus(_:)`). No hard-coded colors.
// ---------------------------------------------------------------------------

/// A rounded, tinted SF Symbol badge — the leading glyph on every alert row.
struct AlertIconBadge: View {
    let systemImage: String
    let status: Theme.SemanticStatus
    var size: CGFloat = 38

    var body: some View {
        Image(safeSystemName: systemImage, fallback: "bell.badge")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(status.tint)
            .frame(width: size, height: size)
            .background(status.wash, in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A tappable card for one *active* alert: provider context, alert title, the
/// message, and a severity badge. Drills into the provider on tap.
struct AlertCard: View {
    let item: ProviderAlertItem

    private var status: Theme.SemanticStatus { .init(item.alert.severity) }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            AlertIconBadge(systemImage: item.alert.symbolName, status: status)

            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    Text(item.provider.title)
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }

                Text(item.alert.title)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)

                Text(item.alert.message)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)

                StatusBadge(item.alert.severity.badgeText, status: status, systemImage: nil)
                    .padding(.top, Theme.Spacing.xxs)
            }
        }
        .dsCard()
        .contentShape(Rectangle())
        .copyableValue("\(item.provider.title) - \(item.alert.title): \(item.alert.message)", label: item.alert.title)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.provider.title), \(item.alert.severity.badgeText): \(item.alert.title)")
        .accessibilityHint(item.alert.message)
        .accessibilityAddTraits(.isButton)
    }
}

/// A compact, non-navigating row for a provider's alert inside the detail view.
struct AlertDetailRow: View {
    let alert: ProviderAlert
    private var status: Theme.SemanticStatus { .init(alert.severity) }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            AlertIconBadge(systemImage: alert.symbolName, status: status, size: 32)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(alert.title)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(alert.message)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .contentShape(Rectangle())
        .copyableValue("\(alert.title): \(alert.message)", label: alert.title)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(alert.severity.badgeText): \(alert.title). \(alert.message)")
    }
}

/// A muted row for a *resolved* alert — dimmed, with a "cleared" checkmark and a
/// relative timestamp.
struct ResolvedAlertRow: View {
    let resolved: ResolvedAlert

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Colors.success)
                .frame(width: 32, height: 32)
                .background(Theme.Colors.success.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    Text(resolved.alert.title)
                        .font(Theme.Typography.callout.weight(.medium))
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(resolved.resolvedAt.formatted(.relative(presentation: .named)))
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
                Text(resolved.providerTitle)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Resolved: \(resolved.alert.title), \(resolved.providerTitle), \(resolved.resolvedAt.formatted(.relative(presentation: .named)))")
    }
}

/// A selectable filter chip for the active severity summary bar.
struct SeverityChip: View {
    let title: String
    let count: Int?
    let status: Theme.SemanticStatus
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(title)
                if let count {
                    Text("\(count)")
                        .monospacedDigit()
                        .foregroundStyle(isSelected ? status.tint : Theme.Colors.tertiaryText)
                }
            }
            .font(Theme.Typography.captionEmphasis)
            .foregroundStyle(isSelected ? status.tint : Theme.Colors.secondaryText)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(
                Capsule().fill(isSelected ? status.wash : Theme.Colors.fill)
            )
            .overlay(
                Capsule().strokeBorder(isSelected ? status.tint.opacity(0.5) : .clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The horizontally-scrolling "All / Critical / Warning / Info" summary bar.
/// Only severities actually present get a chip (plus the always-shown "All").
struct SeveritySummaryBar: View {
    let counts: [AlertSeverity: Int]
    @Binding var selection: AlertSeverityFilter
    var onSelect: (AlertSeverityFilter) -> Void

    private let ordered: [AlertSeverity] = [.critical, .warning, .info]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                SeverityChip(
                    title: AlertSeverityFilter.all.title,
                    count: counts.values.reduce(0, +),
                    status: .neutral,
                    isSelected: selection == .all
                ) { onSelect(.all) }

                ForEach(ordered, id: \.self) { severity in
                    if let count = counts[severity], count > 0 {
                        let filter = severity.filter
                        SeverityChip(
                            title: filter.title,
                            count: count,
                            status: .init(severity),
                            isSelected: selection == filter
                        ) { onSelect(filter) }
                    }
                }
            }
            .padding(.horizontal, Theme.Spacing.xxs)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Filter alerts by severity")
    }
}

/// A non-blocking banner shown when a refresh failed but stale data remains on
/// screen — the app keeps showing the last-known alerts and explains softly.
struct StaleDataBanner: View {
    let error: APIError

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.Colors.warning)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text("Showing saved alerts")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(error.title)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Showing saved alerts. \(error.title). \(error.message)")
    }
}

// MARK: - Domain helpers (Alerts-local)

extension AlertSeverity {
    /// Short badge word for this severity.
    var badgeText: String {
        switch self {
        case .critical: return "Critical"
        case .warning: return "Warning"
        case .info: return "Info"
        }
    }

    /// The matching filter case.
    var filter: AlertSeverityFilter {
        switch self {
        case .critical: return .critical
        case .warning: return .warning
        case .info: return .info
        }
    }
}
