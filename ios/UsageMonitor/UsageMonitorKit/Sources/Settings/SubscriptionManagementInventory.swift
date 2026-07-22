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

    var subscriptions: [SubscriptionSummary] {
        state.value ?? []
    }

    func loadIfNeeded(using client: APIClient) async {
        guard state.value == nil, !state.isLoading else { return }
        await load(using: client, showInitialLoading: true)
    }

    func refresh(using client: APIClient) async {
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
        actionSubscriptionID = id
        actionError = nil
        defer { actionSubscriptionID = nil }
        do {
            _ = try await client.pauseSubscription(id: id)
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
                    }
                } header: {
                    Text("Tracked plans")
                } footer: {
                    Text("Pause is available natively. Purchase, resume, cadence, external-billing links, and environment-knob edits remain on the web because those flows require additional server-validated context.")
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
            Image(systemName: statusSymbol)
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
                        Text("Pausing prevents future synthetic subscription charges. Existing usage and charge history remain intact.")
                    }
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
            Text("The server will stop materializing future recurring charges until the plan is reactivated through a validated resume or repurchase flow.")
        }
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
}
