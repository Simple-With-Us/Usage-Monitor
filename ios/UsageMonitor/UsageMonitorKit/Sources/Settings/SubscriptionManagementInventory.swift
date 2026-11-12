import SwiftUI
import Observation
import AppCore
import DesignSystem
import Models
import Networking

@MainActor
@Observable
final class SubscriptionManagementStore {
    private(set) var state: LoadState<[SubscriptionSummary]> = .idle
    private(set) var actionSubscriptionID: String?
    private(set) var actionError: APIError?
    private var inFlightLoad: Task<Void, Never>?

    var subscriptions: [SubscriptionSummary] {
        state.value ?? []
    }

    func loadIfNeeded(using client: APIClient) async {
        if let inFlightLoad {
            await inFlightLoad.value
            return
        }
        guard state.value == nil, !state.isLoading else { return }
        await load(using: client, showInitialLoading: true)
    }

    func refresh(using client: APIClient) async {
        if let inFlightLoad {
            await inFlightLoad.value
            return
        }
        await load(using: client, showInitialLoading: state.value == nil)
    }

    func pause(
        id: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionSubscriptionID == nil,
              let subscription = subscriptions.first(where: { $0.id == id }),
              subscription.effectiveStatus == "active"
        else {
            return false
        }
        return await mutate(id: id, using: client, afterMutation: afterMutation) { client in
            _ = try await client.pauseSubscription(id: id)
        }
    }

    /// Reactivate a non-active subscription via the server's `activationMode`
    /// contract. `resume` continues the previously paid term; `repurchase`
    /// starts a fresh cycle (the response's `nextRenewalAt` defines the new
    /// term). `renewAutomatically` is only set when repurchasing an expired
    /// term, where the server requires `autoRenew: true` to treat the update
    /// as an activation.
    func activate(
        id: String,
        mode: SubscriptionActivationMode,
        renewAutomatically: Bool? = nil,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionSubscriptionID == nil,
              let subscription = subscriptions.first(where: { $0.id == id }),
              subscription.effectiveStatus != "active"
        else {
            return false
        }
        return await mutate(id: id, using: client, afterMutation: afterMutation) { client in
            _ = try await client.activateSubscription(
                id: id,
                mode: mode,
                renewAutomatically: renewAutomatically
            )
        }
    }

    func delete(
        id: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler
    ) async -> Bool {
        guard actionSubscriptionID == nil,
              subscriptions.contains(where: { $0.id == id })
        else { return false }
        return await mutate(id: id, using: client, afterMutation: afterMutation) { client in
            _ = try await client.deleteSubscription(id: id)
        }
    }

    private func mutate(
        id: String,
        using client: APIClient,
        afterMutation: ManagementMutationHandler,
        action: @MainActor (APIClient) async throws -> Void
    ) async -> Bool {
        actionSubscriptionID = id
        actionError = nil
        defer { actionSubscriptionID = nil }
        do {
            try await action(client)
            await afterMutation()
            await load(using: client, showInitialLoading: false)
            return actionError == nil
        } catch let apiError as APIError {
            actionError = apiError
            return false
        } catch {
            actionError = .transport(error.localizedDescription)
            return false
        }
    }

    private func load(using client: APIClient, showInitialLoading: Bool) async {
        if let inFlightLoad {
            await inFlightLoad.value
            return
        }
        let task = Task { @MainActor in
            defer { self.inFlightLoad = nil }
            await self.performLoad(using: client, showInitialLoading: showInitialLoading)
        }
        inFlightLoad = task
        await task.value
    }

    private func performLoad(using client: APIClient, showInitialLoading: Bool) async {
        if showInitialLoading { state = .loading }
        do {
            let subscriptions = try await client.subscriptions()
            state = .loaded(subscriptions.sorted(by: Self.sort))
            actionError = nil
        } catch is CancellationError {
            return
        } catch let apiError as APIError {
            if state.value == nil {
                state = .failed(apiError)
            } else {
                actionError = apiError
            }
        } catch {
            let apiError = APIError.transport(error.localizedDescription)
            if state.value == nil {
                state = .failed(apiError)
            } else {
                actionError = apiError
            }
        }
    }

    private static func sort(_ left: SubscriptionSummary, _ right: SubscriptionSummary) -> Bool {
        let statusRank = ["active": 0, "considering": 1, "paused": 2, "canceled": 3, "expired": 4]
        let leftRank = statusRank[left.effectiveStatus] ?? 99
        let rightRank = statusRank[right.effectiveStatus] ?? 99
        if leftRank != rightRank { return leftRank < rightRank }
        if left.nextRenewalAt != right.nextRenewalAt {
            return left.nextRenewalAt < right.nextRenewalAt
        }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
}

struct SubscriptionManagementInventoryView: View {
    let client: APIClient
    let afterMutation: ManagementMutationHandler
    @State private var store = SubscriptionManagementStore()
    @State private var pendingDelete: SubscriptionSummary?

    var body: some View {
        List {
            if store.state.isInitialLoading {
                Section("Subscriptions") {
                    ForEach(0..<4, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                            SkeletonBlock(width: 160, height: 14)
                            SkeletonBlock(width: 220, height: 11)
                        }
                        .padding(.vertical, Theme.Spacing.xs)
                    }
                }
            } else if let error = store.state.error {
                Section {
                    ErrorState(
                        title: error.title,
                        message: error.message,
                        retryTitle: error.isRetryable ? "Try Again" : nil
                    ) {
                        Task { await store.refresh(using: client) }
                    }
                }
                .listRowBackground(Color.clear)
            } else if store.subscriptions.isEmpty {
                Section {
                    EmptyState(
                        systemImage: "creditcard.trianglebadge.exclamationmark",
                        title: "No subscriptions",
                        message: "There are no recurring provider plans tracked by this monitor."
                    )
                }
                .listRowBackground(Color.clear)
            } else {
                SubscriptionInventorySummarySection(subscriptions: store.subscriptions)
                Section {
                    ForEach(store.subscriptions) { subscription in
                        NavigationLink {
                            SubscriptionManagementDetailView(
                                subscriptionID: subscription.id,
                                store: store,
                                client: client,
                                afterMutation: afterMutation
                            )
                        } label: {
                            SubscriptionInventoryRow(subscription: subscription)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                pendingDelete = subscription
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                pendingDelete = subscription
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text("Tracked plans")
                } footer: {
                    Text("Swipe left or long-press to delete. Pause, resume, and repurchase are on the detail screen. New purchases and external-billing links remain on the web.")
                }
            }

            if let error = store.actionError {
                Section("Last action") {
                    Label("\(error.title): \(error.message)", systemImage: "exclamationmark.triangle.fill")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.warning)
                }
            }
        }
        .navigationTitle("Subscriptions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh(using: client)
        }
        .task {
            await store.loadIfNeeded(using: client)
        }
        .confirmationDialog(
            "Delete this subscription?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { subscription in
            Button("Delete \(subscription.name)", role: .destructive) {
                Task {
                    let success = await store.delete(
                        id: subscription.id,
                        using: client,
                        afterMutation: afterMutation
                    )
                    success ? Haptics.success() : Haptics.error()
                    pendingDelete = nil
                }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { subscription in
            Text("“\(subscription.name)” will be removed. Already-materialized charges stay in usage history.")
        }

    }
}

private struct SubscriptionInventorySummarySection: View {
    let subscriptions: [SubscriptionSummary]

    var body: some View {
        Section("Portfolio") {
            LabeledContent("Tracked", value: "\(subscriptions.count)")
            LabeledContent(
                "Active",
                value: "\(subscriptions.filter { $0.effectiveStatus == "active" }.count)"
            )
            LabeledContent(
                "Monthly equivalent",
                value: CurrencyFormat.usd(
                    subscriptions
                        .filter { $0.effectiveStatus == "active" }
                        .reduce(0) { $0 + $1.monthlyEquivalentUsd }
                )
            )
        }
    }
}

private struct SubscriptionInventoryRow: View {
    let subscription: SubscriptionSummary

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(safeSystemName: statusSymbol, fallback: "circle")
                .font(.title3)
                .foregroundStyle(status.tint)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(subscription.name)
                Text("\(subscription.provider.title) · \(subscription.cadenceLabel)")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                Text(CurrencyFormat.usd(subscription.monthlyEquivalentUsd))
                    .font(Theme.Typography.callout.weight(.semibold))
                Text("/ month")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(subscription.name), \(subscription.effectiveStatus), \(CurrencyFormat.usd(subscription.monthlyEquivalentUsd)) per month")
    }

    private var status: Theme.SemanticStatus {
        switch subscription.effectiveStatus {
        case "active": return .ok
        case "considering", "paused": return .warning
        case "expired": return .danger
        default: return .neutral
        }
    }

    private var statusSymbol: String {
        switch subscription.effectiveStatus {
        case "active": return "checkmark.circle.fill"
        case "considering": return "sparkles"
        case "paused": return "pause.circle.fill"
        case "expired": return "exclamationmark.circle.fill"
        default: return "xmark.circle.fill"
        }
    }
}

private struct SubscriptionManagementDetailView: View {
    let subscriptionID: String
    let store: SubscriptionManagementStore
    let client: APIClient
    let afterMutation: ManagementMutationHandler
    @State private var showPauseConfirmation = false
    @State private var showReactivateDialog = false

    private var subscription: SubscriptionSummary? {
        store.subscriptions.first { $0.id == subscriptionID }
    }

    var body: some View {
        Form {
            if let subscription {
                Section("Plan") {
                    LabeledContent("Provider", value: subscription.provider.title)
                    LabeledContent("Status", value: subscription.effectiveStatus.capitalized)
                    LabeledContent(
                        "Price",
                        value: "\(CurrencyFormat.usd(subscription.costUsd)) · \(subscription.cadenceLabel)"
                    )
                    LabeledContent(
                        "Monthly equivalent",
                        value: CurrencyFormat.usd(subscription.monthlyEquivalentUsd)
                    )
                    if let project = subscription.project {
                        LabeledContent("Project", value: project.name)
                    }
                }

                Section("Term") {
                    LabeledContent("Auto-renew", value: subscription.autoRenew ? "On" : "Off")
                    if let date = subscription.nextRenewalDate {
                        LabeledContent(
                            subscription.autoRenew ? "Next renewal" : "Term end",
                            value: date.formatted(date: .abbreviated, time: .omitted)
                        )
                    }
                    if let source = subscription.externalBillingSource {
                        LabeledContent("Billing source", value: source)
                    }
                }

                if let notes = subscription.notes, !notes.isEmpty {
                    Section("Notes") {
                        Text(notes)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }

                if let knobEnv = subscription.knobEnv, !knobEnv.isEmpty {
                    Section("Operational capacity") {
                        ForEach(knobEnv.keys.sorted(), id: \.self) { key in
                            LabeledContent(key, value: knobEnv[key] ?? "")
                                .font(Theme.Typography.caption)
                        }
                    }
                }

                if subscription.effectiveStatus == "active" {
                    Section {
                        if subscription.isExternalBillingManaged || subscription.isExternalBillingLinked {
                            managedPauseBanner(subscription)
                        }
                        Button(role: .destructive) {
                            showPauseConfirmation = true
                        } label: {
                            if store.actionSubscriptionID == subscription.id {
                                HStack {
                                    ProgressView()
                                    Text("Pausing…")
                                }
                            } else {
                                Label("Pause subscription", systemImage: "pause.circle")
                            }
                        }
                        .disabled(store.actionSubscriptionID != nil)
                    } footer: {
                        Text(pauseSectionFooter(for: subscription))
                    }
                } else {
                    reactivationSection(subscription)
                }

                if let error = store.actionError {
                    Section("Action failed") {
                        Label("\(error.title): \(error.message)", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.Colors.warning)
                    }
                }
            } else {
                ContentUnavailableView(
                    "Subscription unavailable",
                    systemImage: "questionmark.square.dashed",
                    description: Text("Refresh the inventory and try again.")
                )
            }
        }
        .navigationTitle(subscription?.name ?? "Subscription")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(
            "Pause this subscription?",
            isPresented: $showPauseConfirmation,
            titleVisibility: .visible
        ) {
            Button("Pause subscription", role: .destructive, action: pause)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(pauseWarning)
        }
        .confirmationDialog(
            "Reactivate this subscription?",
            isPresented: $showReactivateDialog,
            titleVisibility: .visible
        ) {
            if subscription?.canAttemptResume != false {
                Button("Resume paid-through term") { activate(mode: .resume) }
            }
            Button("Repurchase — new term starts today") { activate(mode: .repurchase) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Resume continues the already-paid term and charges again at the next renewal. Repurchase starts a fresh billing cycle today and charges the new period. Either choice converts an auto-managed row to owner-managed.")
        }
    }

    /// I5(b): pausing silently relinquishes server-side auto-management for
    /// `externalBillingManaged` rows — make that consequence explicit. The
    /// list DTO may not carry the managed flag, so externally-linked rows get
    /// the cautionary wording when the flag itself is unknown.
    private var pauseWarning: String {
        guard let subscription else {
            return "The server will stop materializing future recurring charges until the plan is reactivated through a validated resume or repurchase flow."
        }
        if subscription.isExternalBillingManaged {
            return "This plan is auto-managed from the provider's billing records. Pausing PERMANENTLY converts it to owner-managed: the monitor will no longer reconcile, pause, or reprice it from billing syncs, and future charges stop until you reactivate it."
        }
        if subscription.isExternalBillingLinked {
            return "This plan is linked to the provider's billing records. If it is auto-managed, pausing permanently converts it to owner-managed. Future charges stop until the plan is reactivated through a validated resume or repurchase flow."
        }
        return "The server will stop materializing future recurring charges until the plan is reactivated through a validated resume or repurchase flow."
    }

    /// In-form banner so managed-row pause is never a silent action — the
    /// confirmation dialog repeats the same consequence.
    @ViewBuilder
    private func managedPauseBanner(_ subscription: SubscriptionSummary) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.Colors.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(subscription.isExternalBillingManaged
                     ? "Auto-managed plan"
                     : "Linked to external billing")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(subscription.isExternalBillingManaged
                     ? "Pausing permanently converts this plan to owner-managed. Billing sync will stop reconciling it."
                     : "If this plan is auto-managed, pausing permanently converts it to owner-managed.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func pauseSectionFooter(for subscription: SubscriptionSummary) -> String {
        if subscription.isExternalBillingManaged {
            return "Pausing stops future charges and permanently relinquishes auto-management. Existing usage and charge history remain intact."
        }
        if subscription.isExternalBillingLinked {
            return "Pausing stops future charges. Linked or auto-managed plans permanently convert to owner-managed on pause. Existing history remains intact."
        }
        return "Pausing prevents future synthetic subscription charges. Existing usage and charge history remain intact."
    }

    @ViewBuilder
    private func reactivationSection(_ subscription: SubscriptionSummary) -> some View {
        Section {
            switch subscription.effectiveStatus {
            case "paused", "canceled":
                actionButton(subscription, label: "Reactivate…", systemImage: "play.circle") {
                    showReactivateDialog = true
                }
            case "considering":
                actionButton(subscription, label: "Mark as purchased", systemImage: "checkmark.circle") {
                    activate(mode: .repurchase)
                }
            case "expired":
                actionButton(subscription, label: "Repurchase — start a new term", systemImage: "arrow.clockwise.circle") {
                    // An expired term has autoRenew off; the server only treats
                    // this as an activation when autoRenew is set back on.
                    activate(mode: .repurchase, renewAutomatically: true)
                }
            default:
                EmptyView()
            }
        } footer: {
            switch subscription.effectiveStatus {
            case "paused", "canceled":
                Text("Resume continues the paid-through term (available when the plan was previously charged); repurchase anchors a fresh cycle today. Reactivating an auto-managed row converts it to owner-managed.")
            case "considering":
                Text("Marks the plan as purchased and starts its first billing cycle today; the next maintenance run records the charge.")
            case "expired":
                Text("Starts a fresh auto-renewing billing cycle today; the next maintenance run records the charge.")
            default:
                EmptyView()
            }
        }
    }

    private func actionButton(
        _ subscription: SubscriptionSummary,
        label: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            if store.actionSubscriptionID == subscription.id {
                HStack {
                    ProgressView()
                    Text("Applying…")
                }
            } else {
                Label(label, systemImage: systemImage)
            }
        }
        .disabled(store.actionSubscriptionID != nil)
    }

    private func pause() {
        Task {
            let success = await store.pause(
                id: subscriptionID,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }

    private func activate(mode: SubscriptionActivationMode, renewAutomatically: Bool? = nil) {
        Task {
            let success = await store.activate(
                id: subscriptionID,
                mode: mode,
                renewAutomatically: renewAutomatically,
                using: client,
                afterMutation: afterMutation
            )
            success ? Haptics.success() : Haptics.error()
        }
    }
}
