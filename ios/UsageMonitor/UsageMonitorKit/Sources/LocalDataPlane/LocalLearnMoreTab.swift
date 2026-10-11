import SwiftUI
import DesignSystem

/// Learn More tab for Usage Local Monitor — the on-device app.
/// Owner 2026-09-09: one tab for what the hosted dashboard and the iPhone app
/// are, what this app can do, and where to read more.  Not an Agents tab.
///
/// Non-actionable: no live data, no Settings state.  Product copy only.
public struct LocalLearnMoreTab: View {
    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                sectionOverview
                sectionFeatures
                sectionPieces
                sectionLearnMore
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Learn More")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: - Sections

    private var sectionOverview: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("This is Usage Local Monitor.  It keeps spend, budgets, and API keys on this device — no hosted server required.")
                    .font(Theme.Typography.body)
                Text("It is one of three Usage Monitor pieces.  The other two are the hosted dashboard and the App Store iPhone app.")
                    .font(Theme.Typography.body)
            }
        } header: {
            Text("What This App Is")
        }
    }

    private var sectionFeatures: some View {
        Section {
            featureRow(
                icon: "chart.pie.fill",
                title: "Month-To-Date Spend",
                detail: "One USD total across connected providers and subscriptions, with budget pacing."
            )
            featureRow(
                icon: "calendar",
                title: "Recurring Fees",
                detail: "Adds each subscription's period charge so it counts in the same month-to-date total."
            )
            featureRow(
                icon: "square.and.arrow.down",
                title: "Local Backup",
                detail: "Export cards, budgets, and fees as a JSON file (not API keys) and restore them on a new device."
            )
            featureRow(
                icon: "faceid",
                title: "App Lock",
                detail: "Optional Face ID or passcode before the dashboard opens."
            )
            featureRow(
                icon: "icloud.slash.fill",
                title: "No Server Required",
                detail: "Saved cards and budgets are viewable offline.  Checking a provider for fresh usage still needs the internet."
            )
        } header: {
            Text("Features")
        } footer: {
            Text("Cards read from the on-device database.  Provider API keys stay in iOS Keychain on this device.")
        }
    }

    private var sectionPieces: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                fleetRow(
                    icon: "iphone",
                    color: Color(red: 0.05, green: 0.72, blue: 0.68),
                    title: "Usage Local Monitor (This App)",
                    detail: "On this device.  Spend and keys stay here."
                )
                fleetRow(
                    icon: "globe",
                    color: Color.blue,
                    title: "Usage.Jays.Services",
                    detail: "Hosted dashboard for the same spend picture in a browser."
                )
                fleetRow(
                    icon: "applelogo",
                    color: Color.indigo,
                    title: "Usage Monitor (iPhone)",
                    detail: "App Store app.  Syncs live with the hosted dashboard, with optional full-access management."
                )
                Text("The hosted dashboard collects usage from your cloud accounts.  The iPhone app is a live-sync client of that dashboard, with optional full-access management.  This local app polls each supported provider directly and lets you track fee-only subscriptions manually — it does not need the hosted dashboard to be up.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        } header: {
            Text("The Three Pieces")
        }
    }

    private var sectionLearnMore: some View {
        Section {
            linkRow(
                icon: "globe",
                title: "Dashboard",
                detail: "usage.jays.services",
                url: "https://usage.jays.services"
            )
            linkRow(
                icon: "arrow.down.app",
                title: "iPhone App",
                detail: "Usage Monitor on the App Store",
                url: "https://apps.apple.com/app/id6820881005"
            )
            linkRow(
                icon: "envelope",
                title: "Support",
                detail: "mail@jays.services",
                url: "mailto:mail@jays.services"
            )
        } header: {
            Text("Learn More")
        }
    }

    // MARK: - Reusable rows

    private func featureRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .padding(.vertical, 2)
    }

    private func fleetRow(icon: String, color: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(color, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private func linkRow(icon: String, title: String, detail: String, url: String) -> some View {
        Link(destination: URL(string: url) ?? URL(string: "https://usage.jays.services")!) {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(detail)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer()
                Image(systemName: "arrow.up.right.square")
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }
}
