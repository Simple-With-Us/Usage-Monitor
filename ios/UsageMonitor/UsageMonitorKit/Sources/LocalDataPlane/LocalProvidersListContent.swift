import SwiftUI
import DesignSystem
import LocalStore
import LocalBudget
import LocalAdapters

/// Providers list with web/remote parity: search, status filter, sort, spend rows.
struct LocalProvidersListContent: View {
    @Bindable var model: LocalAppModel
    @Binding var filter: LocalProviderFilter
    var onAdd: () -> Void
    var onRequestDelete: (LocalProvider) -> Void

    @State private var search = ""
    @State private var sort: LocalProviderSort = .spendDesc

    private var spendById: [String: BudgetEngine.ProviderSpend] {
        Dictionary(
            uniqueKeysWithValues: (model.summary?.providers ?? []).map { ($0.providerId, $0) }
        )
    }

    private var filtered: [LocalProvider] {
        var list = model.providers
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !q.isEmpty {
            list = list.filter {
                $0.displayName.lowercased().contains(q)
                    || $0.name.lowercased().contains(q)
                    || $0.adapterKind.lowercased().contains(q)
            }
        }
        list = list.filter { matchesFilter($0) }
        return list.sorted(by: sortComparator)
    }

    var body: some View {
        List {
            if let s = model.summary {
                Section {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(CurrencyFormat.usd(s.totalSpentUsd))
                                .font(Theme.Typography.hero)
                                .monospacedDigit()
                            Text("this month")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                            Spacer()
                        }
                        HStack(spacing: Theme.Spacing.sm) {
                            Text("\(model.providers.count) provider\(model.providers.count == 1 ? "" : "s")")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                            if s.exceededCount > 0 {
                                StatusBadge("\(s.exceededCount) Over", status: .danger)
                            }
                            if s.warningCount > 0 {
                                StatusBadge("\(s.warningCount) Warning", status: .warning)
                            }
                            if s.exceededCount == 0 && s.warningCount == 0 {
                                StatusBadge("All on Track", status: .ok)
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: Theme.Spacing.sm, leading: Theme.Spacing.lg, bottom: Theme.Spacing.sm, trailing: Theme.Spacing.lg))
                    .listRowBackground(Color.clear)
                }
            }

            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.xs) {
                        ForEach(LocalProviderFilter.allCases) { facet in
                            filterChip(facet)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            if filtered.isEmpty {
                Section {
                    ContentUnavailableView(
                        "No Matches",
                        systemImage: "line.3.horizontal.decrease.circle",
                        description: Text(
                            search.isEmpty
                                ? "No providers match this filter."
                                : "No providers match “\(search)”."
                        )
                    )
                }
            } else {
                Section {
                    ForEach(filtered) { p in
                        NavigationLink(value: p.id) {
                            providerRow(p)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                onRequestDelete(p)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            if p.canFetch {
                                Button {
                                    Task { await model.poll(providerId: p.id) }
                                } label: {
                                    Label("Fetch Now", systemImage: "arrow.triangle.2.circlepath")
                                }
                                Button {
                                    Task {
                                        try? await model.setActive(providerId: p.id, isActive: !p.isActive)
                                    }
                                } label: {
                                    Label(
                                        p.isActive ? "Pause Fetch" : "Resume Fetch",
                                        systemImage: p.isActive ? "pause.circle" : "play.circle"
                                    )
                                }
                            }
                            Button(role: .destructive) {
                                onRequestDelete(p)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text(resultsHeader)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $search, prompt: "Search providers")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Picker("Sort by", selection: $sort) {
                        ForEach(LocalProviderSort.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
            }
        }
        .refreshable {
            await model.refreshAllDue(force: true)
        }
        .overlay {
            if model.providers.isEmpty {
                EmptyState(
                    systemImage: "server.rack",
                    title: "No Providers Yet",
                    message: "Add a provider with a key, or a Recurring Fee.",
                    actionTitle: "Add Provider",
                    action: onAdd
                )
                .padding()
            }
        }
    }

    private var resultsHeader: String {
        let shown = filtered.count
        let total = model.providers.count
        if shown != total { return "Showing \(shown) of \(total)" }
        return "\(total) provider\(total == 1 ? "" : "s")"
    }

    private func filterChip(_ facet: LocalProviderFilter) -> some View {
        let count = model.providers.filter { matchesFilter($0, facet: facet) }.count
        let selected = filter == facet
        return Button {
            Haptics.selection()
            filter = facet
        } label: {
            Text("\(facet.label)\(facet == .all ? "" : " \(count)")")
                .font(Theme.Typography.caption.weight(.semibold))
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xs)
                .background(selected ? Theme.Colors.accent : Theme.Colors.fill, in: Capsule())
                .foregroundStyle(selected ? Color.white : Theme.Colors.primaryText)
        }
        .buttonStyle(.plain)
        .padding(.leading, facet == .all ? Theme.Spacing.lg : 0)
        .padding(.trailing, facet == LocalProviderFilter.allCases.last ? Theme.Spacing.lg : 0)
    }

    @ViewBuilder
    private func providerRow(_ p: LocalProvider) -> some View {
        let spend = spendById[p.id]
        HStack(spacing: Theme.Spacing.md) {
            ProviderMonogram(
                title: p.displayName,
                status: semantic(for: spend?.level ?? .unconfigured),
                size: 34
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(p.displayName)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(rowSubtitle(p, spend: spend))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.Spacing.sm)
            VStack(alignment: .trailing, spacing: 2) {
                Text(CurrencyFormat.usd(spend?.spentUsd ?? 0))
                    .font(Theme.Typography.callout.weight(.semibold))
                    .monospacedDigit()
                if let pct = spend?.percentUsed {
                    Text(CurrencyFormat.percent(pct))
                        .font(Theme.Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(semantic(for: spend?.level ?? .unconfigured).tint)
                } else if p.needsKey {
                    Text("Connect")
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.accent)
                } else if !p.isActive {
                    Text("inactive")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                } else {
                    Text("no budget")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func rowSubtitle(_ p: LocalProvider, spend: BudgetEngine.ProviderSpend?) -> String {
        if let spend {
            switch spend.level {
            case .exceeded:
                if let b = spend.monthlyBudgetUsd {
                    return "over by \(CurrencyFormat.usd(max(0, spend.spentUsd - b)))"
                }
                return "over budget"
            case .warning:
                if let b = spend.monthlyBudgetUsd {
                    return "\(CurrencyFormat.usd(max(0, b - spend.spentUsd))) left"
                }
                return "approaching budget"
            case .ok:
                if let b = spend.monthlyBudgetUsd {
                    return "\(CurrencyFormat.usd(max(0, b - spend.spentUsd))) left"
                }
                return "on track"
            case .unconfigured:
                break
            }
        }
        // Prefer catalog connection summary over internal adapterKind (never "subscription_only").
        if let summary = LocalProviderCatalog.entry(name: p.name)?.connectionSummary {
            var parts = [summary]
            if !p.isActive { parts.append("inactive") }
            if p.isPollable && !p.canFetch { parts.append("needs key") }
            return parts.joined(separator: " · ")
        }
        var parts: [String] = []
        if !p.isActive { parts.append("inactive") }
        if p.isPollable {
            parts.append(p.canFetch ? "polls cost" : "needs key")
        } else {
            parts.append("recurring fee")
        }
        return parts.joined(separator: " · ")
    }

    private func matchesFilter(_ p: LocalProvider, facet: LocalProviderFilter? = nil) -> Bool {
        let f = facet ?? filter
        let spend = spendById[p.id]
        switch f {
        case .all: return true
        case .over: return spend?.level == .exceeded
        case .warning: return spend?.level == .warning
        case .onTrack: return spend?.level == .ok
        case .noBudget: return spend?.level == .unconfigured || spend == nil
        case .inactive: return !p.isActive
        case .active: return p.isActive
        case .needsKey: return p.needsKey
        }
    }

    private func sortComparator(_ a: LocalProvider, _ b: LocalProvider) -> Bool {
        let sa = spendById[a.id]
        let sb = spendById[b.id]
        switch sort {
        case .spendDesc:
            return (sa?.spentUsd ?? 0) > (sb?.spentUsd ?? 0)
        case .nameAsc:
            return a.displayName.localizedCaseInsensitiveCompare(b.displayName) == .orderedAscending
        case .status:
            let oa = statusOrder(sa?.level)
            let ob = statusOrder(sb?.level)
            if oa != ob { return oa < ob }
            return (sa?.spentUsd ?? 0) > (sb?.spentUsd ?? 0)
        }
    }

    private func statusOrder(_ level: BudgetEngine.SpendLevel?) -> Int {
        switch level {
        case .exceeded: return 0
        case .warning: return 1
        case .ok: return 2
        case .unconfigured, .none: return 3
        }
    }

    private func semantic(for level: BudgetEngine.SpendLevel) -> Theme.SemanticStatus {
        switch level {
        case .ok: return .ok
        case .warning: return .warning
        case .exceeded: return .danger
        case .unconfigured: return .neutral
        }
    }
}

enum LocalProviderFilter: String, CaseIterable, Identifiable {
    case all, needsKey, over, warning, onTrack, noBudget, active, inactive
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "All"
        case .needsKey: return "Needs Key"
        case .over: return "Over"
        case .warning: return "Warning"
        case .onTrack: return "On Track"
        case .noBudget: return "No Budget"
        case .active: return "Active"
        case .inactive: return "Inactive"
        }
    }
}

enum LocalProviderSort: String, CaseIterable, Identifiable {
    case spendDesc, nameAsc, status
    var id: String { rawValue }
    var label: String {
        switch self {
        case .spendDesc: return "Spend (High → Low)"
        case .nameAsc: return "Name"
        case .status: return "Status"
        }
    }
}

/// Overview card listing active recurring fees (web Paid Services / Subscriptions parity).
struct LocalRecurringFeesCard: View {
    let subscriptions: [LocalSubscription]
    let providers: [LocalProvider]

    private var active: [LocalSubscription] {
        subscriptions
            .filter { $0.status == "active" && $0.costUsd > 0 }
            .sorted { $0.costUsd > $1.costUsd }
    }

    private var nameById: [String: String] {
        Dictionary(uniqueKeysWithValues: providers.map { ($0.id, $0.displayName) })
    }

    private var monthlyTotal: Double {
        active.reduce(0) { $0 + $1.costUsd }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Recurring Fees",
                subtitle: "Active subscriptions · materialize into MTD spend"
            )
            HStack {
                Text(CurrencyFormat.usd(monthlyTotal))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                Text("monthly run-rate")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
            }
            ForEach(active.prefix(8)) { sub in
                HStack {
                    Text(sub.name)
                        .font(Theme.Typography.callout)
                        .lineLimit(1)
                    Spacer()
                    if let pname = nameById[sub.providerId] {
                        Text(pname)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                            .lineLimit(1)
                    }
                    Text(CurrencyFormat.usd(sub.costUsd))
                        .font(Theme.Typography.callout.weight(.semibold))
                        .monospacedDigit()
                }
            }
            if active.count > 8 {
                Text("+\(active.count - 8) more")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}
