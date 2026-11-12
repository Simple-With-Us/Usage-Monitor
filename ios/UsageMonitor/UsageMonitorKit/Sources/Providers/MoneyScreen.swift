import AppCore
import DesignSystem
import Models
import Networking
import SwiftUI

// ---------------------------------------------------------------------------
// The **Money** screen — the iOS answer to the web `/money` page.
//
// One question, answered at the top: *what does this fleet cost every month?*
// Then the receipts: every paid service, grouped under the provider that bills
// it, with its monthly-equivalent cost and its next renewal date.
//
// Read-and-navigate only.  Pause / resume / repurchase / delete all live in
// Settings → Subscriptions and stay there; duplicating destructive money
// mutations across two lanes is how an owner ends up pausing the same plan
// twice.  The footer card points at the one place that owns them.
//
// Auth: two reads with two different reaches, matching the web Money page.
// `GET /api/subscriptions` is served to a bearer read token *or* a dashboard
// session, and it alone decides whether this screen renders at all — a 401
// there means the stored credential was rejected, and the honest next step is
// the credentials `ErrorState` that lands the user in Settings.
// `GET /api/providers` is dashboard-session-only and carries plan-level fixed
// fees; without a session it degrades to the established "Full Dashboard Access
// Required → Open Settings" card, and the total says out loud that plan-level
// fees are missing rather than quietly understating the bill.
//
// Pushed from an existing screen, so it owns no `NavigationStack` of its own.
// Public entry point — keep `MoneyScreen` + `public init()` stable.
// ---------------------------------------------------------------------------
public struct MoneyScreen: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store = MoneyStore()

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Money")
            .navigationBarTitleDisplayMode(.inline)
            // ONE identity-keyed task, deliberately not two.  A separate
            // unkeyed `.task` would keep running when the identity changed —
            // SwiftUI only cancels and restarts the keyed one — so an
            // in-flight request against the previous host could land last and
            // overwrite the new host's recurring-cost rows.  Keying the only
            // load means a host or credential switch cancels it outright.
            .task(id: env?.accessIdentityRevision) {
                guard let env else { return }
                store.reset()
                await store.loadIfNeeded(using: env.apiClient)
            }
    }

    @ViewBuilder
    private var content: some View {
        if store.state.isInitialLoading {
            loadingView
        } else if let error = store.state.error {
            errorView(for: error)
        } else if let data = store.viewData() {
            if data.isEmpty {
                emptyView(data)
            } else {
                loadedView(data)
            }
        } else {
            loadingView
        }
    }

    private var loadingView: some View {
        VStack(spacing: Theme.Spacing.lg) {
            SkeletonList(rows: 5)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .padding(.vertical, Theme.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.background)
    }

    /// A rejected or absent credential is not a dead end: it gets a prominent
    /// route to the one screen that can fix it.
    @ViewBuilder
    private func errorView(for error: APIError) -> some View {
        let needsCredentials = error == .missingToken || error == .unauthorized
        ErrorState(
            systemImage: needsCredentials ? "key.horizontal.fill" : "exclamationmark.triangle.fill",
            title: needsCredentials ? "Connection Required" : "Costs Unavailable",
            message: needsCredentials
                ? "Add your read token or sign in with the dashboard password in Settings to load recurring costs."
                : error.message,
            actionTitle: needsCredentials ? "Open Settings" : nil,
            action: needsCredentials ? { env?.selectTab?(.settings) } : nil,
            retryTitle: error.isRetryable ? "Try Again" : nil,
            retry: error.isRetryable
                ? {
                    guard let env else { return }
                    Task { await store.load(using: env.apiClient) }
                }
                : nil
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }

    /// "Nothing tracked" is only an honest headline when both recurring-cost
    /// models were actually readable.  With the session-only provider half
    /// refused, a plan-level fixed fee could exist and simply be invisible, so
    /// the copy says that instead of asserting there is nothing.
    private func emptyView(_ data: MoneyViewData) -> some View {
        EmptyState(
            systemImage: "creditcard.trianglebadge.exclamationmark",
            title: "No Paid Services Tracked",
            message: data.needsDashboardSessionForPlanFees
                ? "No tracked subscriptions were found.  Plan-level provider fees are not included without a dashboard session — sign in with the dashboard password in Settings to check for them."
                : "Recurring plans show up here once the monitor records them.  Track a plan in Settings to see its monthly cost and renewal date.",
            actionTitle: "Open Settings",
            action: { env?.selectTab?(.settings) }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }

    private func loadedView(_ data: MoneyViewData) -> some View {
        RefreshableScrollView(
            onRefresh: { [store] in
                guard let client = await MainActor.run(body: { env?.apiClient }) else { return }
                await store.refresh(using: client)
            }
        ) {
            MoneyTotalCard(data: data)
            if data.needsDashboardSessionForPlanFees {
                MoneyPlanFeeAccessCard(openSettings: { env?.selectTab?(.settings) })
            }
            MoneyHighlightTiles(data: data)

            ForEach(data.billingGroups) { group in
                MoneyProviderGroupCard(group: group)
            }

            if !data.considering.isEmpty {
                MoneySecondaryListCard(
                    title: "Considering",
                    subtitle: "Not charging yet — excluded from the monthly total.",
                    rows: data.considering
                )
            }

            if !data.inactive.isEmpty {
                MoneySecondaryListCard(
                    title: "Not Billing",
                    subtitle: "Paused, canceled, or expired — excluded from the monthly total.",
                    rows: data.inactive
                )
            }

            manageFooter
        }
        .background(Theme.Colors.background)
    }

    private var manageFooter: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            SectionHeader("Managing Plans")
            Text("Prices and renewal dates come from the monitor's own records — tracked subscriptions, plus fixed monthly fees recorded on a provider.  Pause, resume, and remove plans in Settings under Subscriptions; edit a provider's plan fee under Providers.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            if env?.selectTab != nil {
                Button("Open Settings") { env?.selectTab?(.settings) }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.Colors.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/// The one figure this screen exists to show: the summed monthly-equivalent
/// cost of everything currently billing, in USD.
struct MoneyTotalCard: View {
    let data: MoneyViewData

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Monthly Recurring")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            Text(data.monthlyTotalLine)
                .font(Theme.Typography.hero)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text(data.summaryLine)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            if data.nonUsdActiveCount > 0 {
                // Mirrors the server's budget math, which excludes non-USD rows
                // rather than guessing an exchange rate.
                Text("Non-USD plans are listed but not converted into the total.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let caveat = data.planFeeCaveat {
                // A total that silently omits plan-level fees is the failure
                // this screen exists to prevent, so the admission travels with
                // the figure itself rather than living further down the page.
                Text(caveat)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        let base = "Monthly recurring \(data.monthlyTotalLine), \(data.summaryLine)"
        guard let caveat = data.planFeeCaveat else { return base }
        return "\(base). \(caveat)"
    }
}

/// The established session-gate affordance (`Providers/KeysAndAppsScreen`,
/// `Dashboard/IntelligenceSection`), scoped to the one thing that is actually
/// missing here.  The subscription half already rendered above it, so this is a
/// capability gap inline on a working screen — never an error state.
struct MoneyPlanFeeAccessCard: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Full Dashboard Access Required")
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(Theme.Colors.primaryText)
            Text("Some recurring fees are recorded on a provider as a fixed monthly cost instead of as a subscription.  Reading them needs a dashboard session, so sign in with the dashboard password in Settings to fold them into the total above.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Settings", action: openSettings)
                .buttonStyle(.borderedProminent)
                .tint(Theme.Colors.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

/// Next money event and portfolio size, side by side.
struct MoneyHighlightTiles: View {
    let data: MoneyViewData

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            StatTile(
                label: "Next Renewal",
                value: renewalValue,
                secondary: renewalSecondary,
                systemImage: "calendar"
            )
            StatTile(
                label: "Active Plans",
                value: "\(data.activeCount)",
                secondary: providerSecondary,
                systemImage: "creditcard.fill"
            )
        }
    }

    private var renewalValue: String {
        guard let date = data.nextRenewal?.renewalDate else { return "None scheduled" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    private var renewalSecondary: String? {
        data.nextRenewal?.name
    }

    private var providerSecondary: String {
        data.providerCount == 1 ? "1 provider" : "\(data.providerCount) providers"
    }
}

// ---------------------------------------------------------------------------
// Provider groups
// ---------------------------------------------------------------------------

/// One card per billing provider, so it is always obvious *who* charges for a
/// service.  The provider's own share of the monthly total sits in the header.
struct MoneyProviderGroupCard: View {
    let group: MoneyViewData.ProviderGroup

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(group.providerTitle, subtitle: group.subtitle) {
                VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                    Text(group.totalLine)
                        .font(Theme.Typography.captionEmphasis)
                        .monospacedDigit()
                        .foregroundStyle(
                            group.hasBudgetedRow
                                ? Theme.Colors.primaryText : Theme.Colors.secondaryText
                        )
                    if group.hasBudgetedRow {
                        Text("per month")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.tertiaryText)
                    }
                }
            }

            ForEach(group.rows) { row in
                if row.id != group.rows.first?.id {
                    Divider().overlay(Theme.Colors.separator.opacity(0.5))
                }
                MoneyServiceRowView(row: row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

/// The non-billing buckets (considering / paused / canceled / expired).  They
/// are shown so nothing silently vanishes, and labelled so they can never be
/// mistaken for money currently going out.
struct MoneySecondaryListCard: View {
    let title: String
    let subtitle: String
    let rows: [MoneyViewData.Row]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(title, subtitle: subtitle)
            ForEach(rows) { row in
                if row.id != rows.first?.id {
                    Divider().overlay(Theme.Colors.separator.opacity(0.5))
                }
                MoneyServiceRowView(row: row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

/// One paid service.  A row with no recorded price shows "Not budgeted" in the
/// secondary text colour — never a fabricated "$0".
struct MoneyServiceRowView: View {
    let row: MoneyViewData.Row

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(row.name)
                        .font(Theme.Typography.body)
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(2)
                    Text(row.subtitleLine)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: Theme.Spacing.sm)
                VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                    Text(row.monthlyLine)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(
                            row.isBudgeted ? Theme.Colors.primaryText : Theme.Colors.secondaryText
                        )
                        .lineLimit(1)
                    Text(row.monthlySecondary)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                        .multilineTextAlignment(.trailing)
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                StatusBadge(row.statusLabel, status: row.status)
                Text(row.renewalLine)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
            }

            if row.isBudgeted, row.priceLine != row.monthlyLine {
                Text(row.priceLine)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }

            if let source = row.billingSource {
                Text("Billing source: \(source)")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }

            if let note = row.originNote {
                // A plan fee and a subscription are edited in different places,
                // so the row says which one it is rather than leaving the owner
                // hunting through Subscriptions for a plan-level charge.
                Text(note)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

#Preview {
    // No `AppEnvironment` is injected, so the screen renders its loading state
    // — enough to check layout and type scale without a live server.
    NavigationStack {
        MoneyScreen()
    }
}
