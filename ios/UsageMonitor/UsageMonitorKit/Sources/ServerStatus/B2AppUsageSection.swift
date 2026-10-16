import SwiftUI
import DesignSystem
import Models
import Networking
import AppCore
import Providers

struct B2AppUsageSection: View {
    @Bindable var store: B2AppUsageStore
    let hasCredential: Bool
    let onRefresh: () async -> Void

    var body: some View {
        switch store.state {
        case .idle, .loading:
            Section {
                ProgressView()
            } header: {
                sectionHeading("B2 Usage by Application")
            }
        case .failed(let error):
            Section {
                Text(error.localizedDescription)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            } header: {
                sectionHeading("B2 Usage by Application")
            }
        case .loaded(let breakdown):
            if breakdown.apps.isEmpty && !breakdown.configured {
                Section {
                    Text("Configure the Backblaze monitor key on the server to load B2 breakdown.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                } header: {
                    sectionHeading("B2 Usage by Application")
                }
            } else {
                Section {
                    b2BreakdownCard(breakdown)
                } header: {
                    sectionHeading("B2 Usage by Application")
                } footer: {
                    if !breakdown.warnings.isEmpty {
                        Text(breakdown.warnings.joined(separator: " · "))
                            .font(Theme.Typography.caption)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func b2BreakdownCard(_ breakdown: B2AppUsageBreakdown) -> some View {
        let records = breakdown.apps.compactMap { app -> ExternalBillingRecord? in
            guard app.storageGb > 0 || app.latestDay != nil else { return nil }
            let bucket = app.bucketNames.first ?? app.id
            return ExternalBillingRecord(
                source: "backblaze-b2-bucket-storage",
                externalId: app.id,
                kind: "service_plan",
                serviceName: bucket,
                planName: "B2 bucket",
                status: "active",
                amountUsd: nil,
                currency: "USD",
                usageQuantity: app.storageGb,
                usageUnit: "GB",
                syncedAt: breakdown.asOf
            )
        }
        if records.isEmpty {
            Text("No B2 usage data yet.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        } else {
            ProviderUsageBreakdownCard(
                providerTitle: "Backblaze B2",
                records: records
            )
            if breakdown.alerts.classCSpike || breakdown.alerts.classCNearCap || breakdown.alerts.downloadNearCap {
                let parts = [
                    breakdown.alerts.classCSpike ? "Class C spike" : nil,
                    breakdown.alerts.classCNearCap ? "Class C near cap" : nil,
                    breakdown.alerts.downloadNearCap ? "Download near cap" : nil,
                ].compactMap { $0 }
                Text(parts.joined(separator: " · "))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
        }
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.sectionHeader)
            .foregroundStyle(Theme.Colors.primaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .textCase(nil)
            .padding(.vertical, 2)
    }
}
