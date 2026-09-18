import SwiftUI
import AppCore
import Dashboard
import DesignSystem
import Models
import Networking

/// Root of the **Agents** lane (tab `.agents`).
///
/// Agent Bar–aligned subscription quota windows (shared UM `/api/quota-windows`
/// data) plus AI coding-agent telemetry for a fixed 30-day overview window.
/// Intentionally no 5h/24h/7d/30d/All lookback strip — those pills were not
/// Agent Bar UX and the baked `?window=` client path 404'd.
public struct AgentsRootView: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store: AgentsStore
    /// Same Agent Bar → UM quota-windows feed the Overview card uses.
    @State private var quotaWindowsStore = QuotaWindowsStore()

    public init() {
        _store = State(initialValue: AgentsStore())
    }

    init(store: AgentsStore) {
        _store = State(initialValue: store)
    }

    public var body: some View {
        NavigationStack {
            List {
                // Agent Bar parity: live subscription quota windows (shared
                // `/api/quota-windows` data), not the odd 5h/24h/7d/30d/All
                // lookback strip that only drove agents-overview.
                Section {
                    SubscriptionQuotasCard(
                        store: quotaWindowsStore,
                        onOpenSettings: { env?.selectTab?(.settings) }
                    )
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                }

                content
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Coding Agents")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                guard let env else { return }
                async let overview: Void = store.refresh(using: env.apiClient)
                async let quotas: Void = quotaWindowsStore.refresh(using: env.apiClient)
                _ = await (overview, quotas)
            }
        }
        .task(id: env?.accessIdentityRevision) {
            guard let env else { return }
            store.reset()
            quotaWindowsStore.reset()
            async let overview: Void = store.loadIfNeeded(using: env.apiClient)
            async let quotas: Void = quotaWindowsStore.loadIfNeeded(using: env.apiClient)
            _ = await (overview, quotas)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let data = store.state.value {
                loaded(data)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            Section {
                HStack {
                    SkeletonBlock(width: 120, height: 14)
                    Spacer()
                    SkeletonBlock(width: 60, height: 14)
                }
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(error.title)
                    .font(Theme.Typography.captionEmphasis)
                Text(error.message)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Button {
                    guard let env else { return }
                    Task { await store.refresh(using: env.apiClient) }
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise")
                        .font(Theme.Typography.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .tint(Theme.Colors.accent)
            }
        }
    }

    @ViewBuilder
    private func loaded(_ data: AgentsOverviewResponse) -> some View {
        summarySection(data)
        if data.burn5h.tokens5h > 0 {
            burnSection(data.burn5h)
        }
        platformsSection(data.platforms)
        if !data.modelDistribution.isEmpty {
            modelDistributionSection(data.modelDistribution)
        }
    }

    @ViewBuilder
    private func summarySection(_ data: AgentsOverviewResponse) -> some View {
        Section {
            let activeText = "\(data.summary.activeAgentCount)/\(data.summary.totalAgentCount) Active"
            LabeledContent("Active on Mac") {
                StatusBadge(
                    activeText,
                    status: data.summary.activeAgentCount > 0 ? .ok : .neutral,
                    systemImage: "desktopcomputer"
                )
            }
            .copyableRow(label: "Active on Mac", value: activeText)
            LabeledContent("Host Chip", value: data.macChip)
                .copyableRow(label: "Host Chip", value: data.macChip)
            let tokensStr = formatTokens(data.summary.totalTokens)
            LabeledContent("Total Tokens", value: tokensStr)
                .copyableRow(label: "Total Tokens", value: tokensStr)
            if data.summary.telemetryIncomplete == true {
                Text(data.summary.telemetryIncompleteNote ?? "Some seats are not reporting usage.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
                    .copyableRow(
                        label: "Telemetry Accuracy",
                        value: data.summary.telemetryIncompleteNote ?? "Some seats are not reporting usage."
                    )
            }
            let paygStr = formatCurrency(data.summary.totalApiEquivalentCostUsd)
            LabeledContent("PAYG Value", value: paygStr)
                .copyableRow(label: "PAYG Value", value: paygStr)
            let savingsStr = "+\(formatCurrency(data.summary.totalNetSavingsUsd))"
            LabeledContent("Net Savings") {
                Text(savingsStr)
                    .font(Theme.Typography.body.weight(.bold))
                    .foregroundStyle(Theme.Colors.success)
            }
            .copyableRow(label: "Net Savings", value: savingsStr)
        } header: {
            Text("Fleet Summary · \(data.windowLabel)")
        } footer: {
            Text(data.summary.telemetryIncomplete == true
                 ? "Token totals omit seats that are not reporting usage.  This is not zero use."
                 : "API Equivalent compares token volume with direct LiteLLM catalog list rates.")
        }
    }

    @ViewBuilder
    private func burnSection(_ burn: Burn5hSummary) -> some View {
        Section {
            let burnTokensStr = formatTokens(burn.tokens5h)
            LabeledContent("5h Token Burn", value: burnTokensStr)
                .copyableRow(label: "5h Token Burn", value: burnTokensStr)
            let burnCostStr = formatCurrency(burn.costEstimate5hUsd)
            LabeledContent("5h Cost Estimate", value: burnCostStr)
                .copyableRow(label: "5h Cost Estimate", value: burnCostStr)
            let rateStr = "\(formatTokens(burn.burnRateTokensPerHour))/hr"
            LabeledContent("Token Burn Rate", value: rateStr)
                .copyableRow(label: "Token Burn Rate", value: rateStr)
            let paceStr = "\(formatCurrency(burn.burnRateUsdPerHour))/hr"
            LabeledContent("Spend Pace", value: paceStr)
                .copyableRow(label: "Spend Pace", value: paceStr)
        } header: {
            Text("5-Hour Rolling Activity")
        } footer: {
            Text("CCUsage 5-hour billing block activity pace.")
        }
    }

    @ViewBuilder
    private func platformsSection(_ platforms: [AgentPlatformStatus]) -> some View {
        Group {
            ForEach(platforms) { platform in
                Section {
                    let statusStr = platform.isRunningOnMac ? "Active on Mac" : "Idle on Mac"
                    LabeledContent("Status") {
                        StatusBadge(
                            statusStr,
                            status: platform.isRunningOnMac ? .ok : .neutral,
                            systemImage: platform.isRunningOnMac ? "checkmark.circle.fill" : "circle"
                        )
                    }
                    .copyableRow(label: "\(platform.name) Status", value: statusStr)
                    let seatName = platform.seatPlanName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let seatStr = seatName.isEmpty
                        ? platform.seatCostDisplay
                        : "\(seatName) · \(platform.seatCostDisplay)"
                    LabeledContent("Seat Cost", value: seatStr)
                        .copyableRow(label: "\(platform.name) Seat Cost", value: seatStr)
                    if let billed = platform.billedMonthlySeatCostUsd,
                       billed + 0.5 < (platform.listMonthlySeatCostUsd ?? platform.monthlySeatCostUsd) {
                        let billedStr = "$\(Int(billed.rounded()))/mo billed"
                        LabeledContent("Billed This Month", value: billedStr)
                            .copyableRow(label: "\(platform.name) Billed Seat", value: billedStr)
                    }
                    if let seatNote = platform.seatCostNote, !seatNote.isEmpty {
                        Text(seatNote)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    if !platform.reportsUsage {
                        StatusBadge(
                            platform.telemetryAccuracyLabel ?? "not reported",
                            status: .warning,
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        Text(platform.telemetryAccuracyNote ?? "Usage is not reported.  This is not zero usage.")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.warning)
                    }
                    let pTokensStr = platform.reportsUsage ? formatTokens(platform.totalTokens) : "not reported"
                    LabeledContent("Tokens Processed", value: pTokensStr)
                        .copyableRow(label: "\(platform.name) Tokens", value: pTokensStr)
                    let pPaygStr = platform.reportsUsage ? formatCurrency(platform.estimatedCostUsd) : "not reported"
                    LabeledContent("PAYG Value", value: pPaygStr)
                        .copyableRow(label: "\(platform.name) PAYG Value", value: pPaygStr)
                    let pSavingsStr = platform.reportsUsage
                        ? "+\(formatCurrency(platform.netSavingsUsd))"
                        : "not reported"
                    LabeledContent("Net Savings") {
                        Text(pSavingsStr)
                            .foregroundStyle(platform.reportsUsage ? Theme.Colors.success : Theme.Colors.warning)
                    }
                    .copyableRow(label: "\(platform.name) Net Savings", value: pSavingsStr)

                    if platform.reportsUsage && !platform.modelsUsed.isEmpty {
                        ForEach(platform.modelsUsed) { model in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(model.model)
                                        .font(Theme.Typography.captionEmphasis)
                                    Spacer()
                                    Text("\(formatTokens(model.tokens)) (\(Int(model.percentOfPlatform))%)")
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                                ProgressView(value: max(0.02, model.percentOfPlatform / 100))
                                    .tint(Theme.Colors.accent)
                            }
                            .padding(.vertical, 2)
                            .copyableValue("\(model.model): \(formatTokens(model.tokens)) (\(Int(model.percentOfPlatform))%)", label: model.model)
                        }
                    }
                } header: {
                    HStack {
                        Text(platform.name)
                        Spacer()
                        Text(platform.provider)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } footer: {
                    Text(platform.telemetryAccuracyNote ?? platform.dataCapability)
                }
            }
        }
    }

    @ViewBuilder
    private func modelDistributionSection(_ distribution: [ModelDistributionItem]) -> some View {
        Section {
            ForEach(distribution) { item in
                LabeledContent(item.model) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("\(formatTokens(item.tokens)) (\(String(format: "%.1f", item.percent))%)")
                            .font(Theme.Typography.caption)
                        Text(formatCurrency(item.apiEquivalentCostUsd))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.success)
                    }
                }
                .copyableValue("\(item.model): \(formatTokens(item.tokens)) (\(String(format: "%.1f", item.percent))%), \(formatCurrency(item.apiEquivalentCostUsd))", label: item.model)
            }
        } header: {
            Text("Model Distribution")
        }
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000_000 {
            return String(format: "%.2fB", Double(count) / 1_000_000_000)
        } else if count >= 1_000_000 {
            return String(format: "%.2fM", Double(count) / 1_000_000)
        } else if count >= 1_000 {
            return String(format: "%.1fk", Double(count) / 1_000)
        }
        return "\(count)"
    }

    private func formatCurrency(_ usd: Double) -> String {
        String(format: "$%.2f", usd)
    }
}
