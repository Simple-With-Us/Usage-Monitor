import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Typed navigation value for pushing a provider detail. Carrying only the id
/// keeps navigation state small and lets the detail re-resolve the *current*
/// provider from the shared store after a refresh.
struct ProviderRoute: Hashable {
    let id: String
}

/// Per-provider budget detail. Budget data comes from the
/// `ProviderBudgetStatus` already present in the shared `BudgetStore`
/// response. When a dashboard session is active, the view additionally loads
/// recorded snapshot history (`GET /api/snapshots`) and provider-reported
/// external billing (`GET /api/providers/:id`) through `ProviderDepthStore` —
/// both session-gated routes, degrading gracefully (labeled estimate +
/// sign-in hint) when no session is available.
struct ProviderDetailView: View {
    let route: ProviderRoute
    @Environment(BudgetStore.self) private var store
    /// Optional so previews (store-only) don't trap; the app injects it.
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var depthStore = ProviderDepthStore()
    @State private var showBudgetEditor = false

    /// Always resolve from the live store so a pull-to-refresh updates the
    /// numbers in place.
    private var provider: ProviderBudgetStatus? {
        store.providers.first { $0.id == route.id }
    }

    var body: some View {
        Group {
            if let provider {
                content(for: provider)
            } else {
                EmptyState(
                    systemImage: "questionmark.square.dashed",
                    title: "Provider unavailable",
                    message: "This provider is no longer in the latest budget report."
                )
                .frame(maxHeight: .infinity)
                .dsScreenBackground()
            }
        }
        .navigationTitle(provider?.title ?? "Provider")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if provider != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit Budget") {
                        Haptics.tap()
                        showBudgetEditor = true
                    }
                    .accessibilityHint("Opens the monthly budget editor. Requires full access.")
                }
            }
        }
        .sheet(isPresented: $showBudgetEditor) {
            ProviderBudgetEditSheet(
                providerID: route.id,
                providerTitle: provider?.title ?? "Provider",
                currentBudgetUsd: provider?.monthlyBudgetUsd,
                client: env?.apiClient,
                onSaved: {
                    showBudgetEditor = false
                    Task { await store.refresh() }
                },
                onRequestSignIn: {
                    showBudgetEditor = false
                    env?.selectTab?(.settings)
                }
            )
            .presentationDetents([.medium, .large])
        }
        .task { await store.loadIfNeeded() }
        .task(id: route.id) { [apiClient = env?.apiClient] in
            if let apiClient {
                await depthStore.loadIfNeeded(providerID: route.id, using: apiClient)
            }
        }
    }

    @ViewBuilder
    private func content(for provider: ProviderBudgetStatus) -> some View {
        RefreshableScrollView(onRefresh: { [apiClient = env?.apiClient] in
            await store.refresh()
            if let apiClient {
                await depthStore.refresh(providerID: route.id, using: apiClient)
            }
        }) {
            header(provider)
            if store.lastError != nil {
                refreshBanner
            }
            budgetCard(provider)
            statGrid(provider)
            if !provider.spendComponents.isEmpty {
                compositionCard(provider)
            }
            let billingRecords = !depthStore.billingRecords.isEmpty ? depthStore.billingRecords : (provider.externalBilling ?? [])
            if !billingRecords.isEmpty {
                ProviderUsageBreakdownCard(
                    providerTitle: provider.title,
                    records: billingRecords
                )
            }
            historySection(provider)
            if !billingRecords.isEmpty {
                ExternalBillingCard(records: billingRecords)
            }
            if provider.hasRenewalContext {
                renewalCard(provider)
            }
            dataQualityCard(provider)
            identifierCard(provider)
            if depthStore.requiresSession {
                sessionHintCard
            }
            if !provider.alerts.isEmpty {
                alertsSection(provider)
            }
        }
    }

    // MARK: - Header

    private func header(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.md) {
                ProviderMonogram(
                    title: provider.title,
                    status: provider.semanticStatus,
                    size: 52
                )
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(provider.title)
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(1)
                    Text(provider.spentUsd, format: .currency(code: "USD"))
                        .font(Theme.Typography.hero)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                        .accessibilityLabel("Spent this month, \(CurrencyFormat.usd(provider.spentUsd))")
                }
            }

            HStack(spacing: Theme.Spacing.sm) {
                StatusBadge(provider.statusLabel, status: provider.semanticStatus, systemImage: provider.statusSymbol)
                if !provider.spendCoverage.isComplete {
                    StatusBadge(provider.spendCoverage.label, status: .init(coverage: provider.spendCoverage), systemImage: "chart.pie")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var refreshBanner: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
            Text("Showing last loaded data — refresh failed.")
                .font(Theme.Typography.caption)
            Spacer()
        }
        .foregroundStyle(Theme.Colors.warning)
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: - Budget

    @ViewBuilder
    private func budgetCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Budget", subtitle: provider.hasBudget ? "Month to Date" : nil) {
                Button {
                    Haptics.tap()
                    showBudgetEditor = true
                } label: {
                    Text(provider.hasBudget ? "Edit" : "Set budget")
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.accent)
                }
                .accessibilityLabel(provider.hasBudget ? "Edit monthly budget" : "Set monthly budget")
            }
            if provider.hasBudget, let budget = provider.monthlyBudgetUsd {
                LabeledBudgetMeter(
                    title: provider.hasBudget ? "\(CurrencyFormat.percent(provider.budgetFraction)) used" : "Spend",
                    detail: "\(CurrencyFormat.usd(provider.spentUsd)) / \(CurrencyFormat.usd(budget))",
                    fraction: provider.budgetFraction,
                    status: provider.semanticStatus
                )
            } else {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "minus.circle")
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Text("No monthly budget configured for this provider.")
                        .font(Theme.Typography.callout)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Stat grid

    private func statGrid(_ provider: ProviderBudgetStatus) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible()), GridItem(.flexible())],
            spacing: Theme.Spacing.md
        ) {
            StatTile(
                label: "Spent",
                value: CurrencyFormat.usd(provider.spentUsd),
                secondary: "this month",
                systemImage: "creditcard.fill"
            )
            StatTile(
                label: "Projected",
                value: CurrencyFormat.usd(provider.projectedEomUsd),
                secondary: providerProjectionSecondary(provider),
                systemImage: "chart.line.uptrend.xyaxis",
                status: projectionStatus(provider)
            )
            if let remaining = provider.remainingUsd {
                StatTile(
                    label: remaining < 0 ? "Over By" : "Remaining",
                    value: CurrencyFormat.usd(abs(remaining)),
                    secondary: "of budget",
                    systemImage: remaining < 0 ? "exclamationmark.triangle.fill" : "banknote",
                    status: remaining < 0 ? .danger : .ok
                )
            } else {
                StatTile(
                    label: "Budget",
                    value: "no budget set",
                    secondary: nil,
                    systemImage: "banknote",
                    status: .neutral
                )
            }
            if provider.hasBudget, let percent = provider.percentUsed {
                StatTile(
                    label: "Utilisation",
                    value: CurrencyFormat.percent(percent),
                    secondary: "of budget",
                    systemImage: "gauge.with.dots.needle.67percent",
                    status: provider.semanticStatus
                )
            } else if provider.estimatedApiEquivalentUsd > 0 {
                StatTile(
                    label: "API-Equivalent",
                    value: CurrencyFormat.usd(provider.estimatedApiEquivalentUsd),
                    secondary: "list-price value",
                    systemImage: "tag.fill"
                )
            }
        }
    }

    /// Prefer the server's `projectedStatus` (computed from the same
    /// `projectedEomUsd`-vs-budget thresholds the web uses) so the two UIs
    /// cannot disagree; fall back to local projection math for payloads that
    /// predate the field.
    private func projectionStatus(_ provider: ProviderBudgetStatus) -> Theme.SemanticStatus {
        if let projected = provider.projectedStatus {
            return Theme.SemanticStatus(projected)
        }
        guard let budget = provider.monthlyBudgetUsd, budget > 0 else { return .neutral }
        if provider.projectedEomUsd > budget { return .danger }
        if provider.projectedEomUsd > budget * 0.9 { return .warning }
        return .ok
    }

    // MARK: - Composition

    private func compositionCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Spend Breakdown", subtitle: "How this month's \(CurrencyFormat.usd(provider.spentUsd)) is made up")
            SpendCompositionBar(components: provider.spendComponents)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - History / pace

    /// The money-history chart. When recorded snapshot history loads (session
    /// required), this is the real reported-spend series; otherwise it falls
    /// back to the synthesized linear pace curve, explicitly labeled as an
    /// estimate so it can never be mistaken for billed history. Range options
    /// match the website provider-detail control (7 / 30 / 90 / 365 days).
    @ViewBuilder
    private func historySection(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if showsHistoryRangeControl {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    HStack {
                        Text("Reported spend history")
                            .font(Theme.Typography.sectionHeader)
                            .foregroundStyle(Theme.Colors.primaryText)
                        Spacer()
                        if depthStore.isReloadingHistory {
                            ProgressView().controlSize(.small)
                        }
                    }
                    Picker("History range", selection: historyRangeBinding) {
                        ForEach(SnapshotHistoryRange.allCases) { range in
                            Text(range.shortLabel).tag(range)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(depthStore.isReloadingHistory)
                    .accessibilityLabel("Snapshot history range")
                    .accessibilityValue(depthStore.historyRange.displayLabel)
                    .accessibilityHint("Does not change month-to-date budget totals.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .dsCard()
            }

            if let points = depthStore.spendHistoryPoints,
               let latest = depthStore.latestRecordedSpend {
                SparklineCard(
                    title: showsHistoryRangeControl ? "" : "Reported spend history",
                    value: CurrencyFormat.usd(latest),
                    caption: depthStore.historyCaption,
                    points: points,
                    status: projectionStatus(provider)
                )
                .opacity(depthStore.isReloadingHistory ? 0.55 : 1)
                .accessibilityHint(
                    depthStore.isReloadingHistory
                        ? "Reloading history for \(depthStore.historyRange.displayLabel)"
                        : "History window \(depthStore.historyRange.displayLabel)"
                )
            } else if depthStore.historyState.isLoading {
                SkeletonBlock(height: 120, radius: Theme.Radius.lg)
                    .accessibilityLabel("Loading reported spend history")
            } else {
                paceCard(provider)
            }
        }
    }

    private var showsHistoryRangeControl: Bool {
        if depthStore.isReloadingHistory { return true }
        switch depthStore.historyState {
        case .loading, .loaded:
            return true
        case .idle, .failed:
            return false
        }
    }

    private var historyRangeBinding: Binding<SnapshotHistoryRange> {
        Binding(
            get: { depthStore.historyRange },
            set: { newRange in
                guard newRange != depthStore.historyRange else { return }
                Haptics.tap()
                Task {
                    await depthStore.selectHistoryRange(
                        newRange,
                        providerID: route.id,
                        using: env?.apiClient
                    )
                }
            }
        )
    }

    private func paceCard(_ provider: ProviderBudgetStatus) -> some View {
        let points = pacePoints(spent: provider.spentUsd, projected: provider.projectedEomUsd)
        let deltaCaption: String? = {
            guard provider.projectedEomUsd > 0 else { return nil }
            let pct = (provider.projectedEomUsd - provider.spentUsd) / max(provider.spentUsd, 0.01)
            return "+\(CurrencyFormat.percent(pct)) to EOM"
        }()
        return SparklineCard(
            title: "Pace to month-end — estimated",
            value: CurrencyFormat.usd(provider.projectedEomUsd),
            caption: deltaCaption,
            points: points,
            status: projectionStatus(provider)
        )
    }

    /// Synthesise a cumulative-spend pace curve for the current month: linear to
    /// today at the observed run-rate, then extrapolated to the projected
    /// end-of-month figure. There is no per-day series in the model, so this is
    /// an at-pace illustration, not billed history — only shown as the fallback
    /// when no recorded history is available, and labeled as an estimate.
    private func pacePoints(spent: Double, projected: Double) -> [Double] {
        let calendar = Calendar.current
        let now = Date()
        let day = calendar.component(.day, from: now)
        let range = calendar.range(of: .day, in: .month, for: now)
        let daysInMonth = range?.count ?? 30
        guard day >= 1, daysInMonth >= day, spent >= 0 else { return [0, spent, projected] }

        let dailyToDate = spent / Double(day)
        var points: [Double] = []
        for d in 1...day { points.append(dailyToDate * Double(d)) }
        if day < daysInMonth {
            let remainingDays = daysInMonth - day
            let dailyProjected = (projected - spent) / Double(remainingDays)
            for d in 1...remainingDays { points.append(spent + dailyProjected * Double(d)) }
        }
        return points
    }

    // MARK: - Renewal

    private func renewalCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "EOM Projection Parts",
                subtitle: "Usage pace + fixed accrued + known renewals"
            )
            DetailStatRow(
                label: "Usage (Extrapolated)",
                value: CurrencyFormat.usd(provider.resolvedProjectedVariableUsageUsd)
            )
            DetailStatRow(
                label: "Fixed Accrued MTD",
                value: CurrencyFormat.usd(provider.resolvedFixedAccruedUsd)
            )
            DetailStatRow(
                label: "Known Renewals Remaining",
                value: CurrencyFormat.usd(provider.resolvedForecastedSubscriptionRenewalsUsd)
            )
            if provider.subscriptionMonthToDateUsd > 0.005 {
                DetailStatRow(label: "Subscription This Month", value: CurrencyFormat.usd(provider.subscriptionMonthToDateUsd))
            }
            if provider.fixedMonthlyCostUsd > 0.005 {
                DetailStatRow(label: "Plan Fixed Monthly", value: CurrencyFormat.usd(provider.fixedMonthlyCostUsd))
            }
            Text("Projected \(CurrencyFormat.usd(provider.projectedEomUsd)) = usage + fixed + renewals. Subscriptions with a next bill this month appear under renewals even before they charge.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func providerProjectionSecondary(_ provider: ProviderBudgetStatus) -> String {
        let renew = provider.resolvedForecastedSubscriptionRenewalsUsd
        let fixed = provider.resolvedFixedAccruedUsd
        // Secondary is a value → sentence case.
        if renew > 0.005 || fixed > 0.005 {
            return "usage + subs"
        }
        return "usage pace · eom"
    }

    // MARK: - Data quality

    private func dataQualityCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Data Quality")
            DetailStatRow(
                label: "Spend Coverage",
                value: provider.spendCoverage.label,
                valueStatus: .init(coverage: provider.spendCoverage),
                monospaced: false
            )
            if provider.pushedMonthToDateUsd > 0.005 {
                DetailStatRow(label: "Reported (Pushed)", value: CurrencyFormat.usd(provider.pushedMonthToDateUsd))
            }
            if provider.receiptCashPaidUsd > 0.005 {
                DetailStatRow(label: "Cash Paid (Receipts)", value: CurrencyFormat.usd(provider.receiptCashPaidUsd))
            }
            if provider.estimatedApiEquivalentUsd > 0.005 {
                DetailStatRow(label: "API-Equivalent Value", value: CurrencyFormat.usd(provider.estimatedApiEquivalentUsd))
            }
            if let fetched = provider.snapshotFetchedDate {
                DetailStatRow(
                    label: "Snapshot Updated",
                    // Relative times are values → keep lower/sentence from system formatter.
                    value: fetched.formatted(.relative(presentation: .named)),
                    monospaced: false
                )
            }
            Text("Most providers omit sales tax, VAT, and invoice-only fees from usage APIs. Partial coverage means the number is incomplete — set fixed monthly cost or a subscription when you know the real bill.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Identifier

    /// The budget-status payload carries no key material, so this card shows
    /// the provider slug only. It must NEVER mask the provider's database id
    /// and present it as a credential preview — the real masked key preview
    /// lives in Settings → Provider inventory (full access), decoded from the
    /// management DTO's `keyPreview`.
    private func identifierCard(_ provider: ProviderBudgetStatus) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Identifier")
            DetailStatRow(label: "Slug", value: provider.name, monospaced: false)
            Text("The masked credential preview is available in Settings → Provider inventory when full access is enabled.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Session hint

    /// Shown when the depth reads were rejected for lack of a dashboard
    /// session: explains what full access unlocks and offers a jump to
    /// Settings, so the section is never a dead end.
    private var sessionHintCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label("History & provider billing", systemImage: "lock.shield")
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(Theme.Colors.primaryText)
            Text("Recorded usage history and provider-reported billing need full access. Sign in with the dashboard password from Settings.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Haptics.tap()
                env?.selectTab?(.settings)
            } label: {
                Text("Open Settings")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.accent)
            }
            .accessibilityHint("Jumps to the Settings tab to sign in for full access")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .accessibilityElement(children: .contain)
    }

    // MARK: - Alerts

    private func alertsSection(_ provider: ProviderBudgetStatus) -> some View {
        let alerts = provider.alerts.sorted { $0.severity.order < $1.severity.order }
        return VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Alerts") {
                Text("\(alerts.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            VStack(spacing: Theme.Spacing.sm) {
                ForEach(alerts) { alert in
                    HStack(alignment: .top, spacing: Theme.Spacing.md) {
                        Image(safeSystemName: alert.symbolName, fallback: "bell.badge")
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(Theme.SemanticStatus(alert.severity).tint)
                            .frame(width: 26)
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(alert.title). \(alert.message)")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Detail — over budget (light)") {
    ProviderDetailPreviewHost(provider: .sampleExceeded)
        .preferredColorScheme(.light)
}

#Preview("Detail — warning (dark)") {
    ProviderDetailPreviewHost(provider: .sampleWarning)
        .preferredColorScheme(.dark)
}

#Preview("Detail — no budget") {
    ProviderDetailPreviewHost(provider: .sampleUnconfigured)
}

/// Preview host that seeds a real `BudgetStore` with a single provider (through
/// the stubbed network path) so the detail resolves it by id.
private struct ProviderDetailPreviewHost: View {
    let provider: ProviderBudgetStatus
    @State private var store: BudgetStore

    init(provider: ProviderBudgetStatus) {
        self.provider = provider
        _store = State(initialValue: ProviderPreview.store(
            with: BudgetStatusResponse(
                ok: true,
                generatedAt: "2026-07-19T09:15:00.000Z",
                month: "2026-07",
                providers: [provider],
                summary: .sample
            )
        ))
    }

    var body: some View {
        NavigationStack {
            ProviderDetailView(route: ProviderRoute(id: provider.id))
                .environment(store)
        }
    }
}
#endif
