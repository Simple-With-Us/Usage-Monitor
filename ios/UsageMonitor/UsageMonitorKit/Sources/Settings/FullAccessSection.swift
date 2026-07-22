import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Dashboard-session login and the gateway to native management inventory.
/// The password exists only in this view's transient field and is cleared
/// before the request begins; only the server's HttpOnly cookie persists.
struct FullAccessSection: View {
    @Environment(AppEnvironment.self) private var env
    @Bindable var store: ManagementAccessStore
    @State private var password = ""
    @State private var showSignOutConfirmation = false
    @FocusState private var passwordFocused: Bool

    var body: some View {
        Section {
            AccessCapabilityRow(
                title: "Read access",
                detail: readDetail,
                systemImage: "chart.bar.doc.horizontal",
                status: store.capabilities.canRead ? .ok : .neutral
            )
            AccessCapabilityRow(
                title: "Management",
                detail: managementDetail,
                systemImage: "slider.horizontal.3",
                status: store.capabilities.canManage ? .ok : .neutral
            )

            if store.capabilities.canManage {
                NavigationLink {
                    ProviderManagementInventoryView(
                        client: env.apiClient,
                        afterMutation: refreshSharedBudget
                    )
                } label: {
                    Label("Provider inventory", systemImage: "square.stack.3d.up")
                }
                NavigationLink {
                    SubscriptionManagementInventoryView(
                        client: env.apiClient,
                        afterMutation: refreshSharedBudget
                    )
                } label: {
                    Label("Tracked subscriptions", systemImage: "creditcard")
                }
                Button(role: .destructive) {
                    showSignOutConfirmation = true
                } label: {
                    Label("Sign out of full access", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .disabled(store.isAuthenticating)
            } else {
                SecureField("Dashboard password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($passwordFocused)
                    .onSubmit(signIn)
                    .accessibilityLabel("Dashboard password")

                Button(action: signIn) {
                    HStack {
                        Spacer()
                        if store.isAuthenticating {
                            ProgressView().tint(.white)
                        } else {
                            Label("Enable Full Access", systemImage: "lock.open.fill")
                                .font(Theme.Typography.callout.weight(.semibold))
                        }
                        Spacer()
                    }
                    .padding(.vertical, Theme.Spacing.xs)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.Colors.accent)
                .disabled(trimmedPassword.isEmpty || store.isAuthenticating)
                .listRowBackground(Color.clear)
            }

            if store.isLoading {
                HStack(spacing: Theme.Spacing.sm) {
                    ProgressView()
                    Text("Checking access…")
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }

            if let error = store.error {
                Label {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(error.title).font(Theme.Typography.captionEmphasis)
                        Text(error.message)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.Colors.warning)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Full Access")
        } footer: {
            Text("The dashboard password is sent once over HTTPS and never stored. Full access persists only as the monitor's HttpOnly session cookie. Complex provider credentials and subscription purchase/resume flows remain server-validated on the web.")
        }
        .confirmationDialog(
            "Sign out of full access?",
            isPresented: $showSignOutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive, action: signOut)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your read token, if configured, stays in the Keychain. Native management actions will require the dashboard password again.")
        }
    }

    private var trimmedPassword: String {
        password.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var readDetail: String {
        switch store.capabilities.bearerRead {
        case .configured:
            return store.capabilities.sessionManagement.isActive
                ? "Bearer configured · session active"
                : "Bearer configured"
        case .notConfigured:
            return store.capabilities.sessionManagement.isActive
                ? "Dashboard session"
                : "Not configured"
        }
    }

    private var managementDetail: String {
        guard let count = store.capabilities.sessionManagement.providerCount else {
            return "Signed out"
        }
        return "Full access · \(count) provider\(count == 1 ? "" : "s")"
    }

    private func refreshSharedBudget() async {
        await env.budgetStore.refresh()
    }

    private func signIn() {
        let candidate = trimmedPassword
        guard !candidate.isEmpty else { return }
        password = ""
        passwordFocused = false
        Task {
            if await store.login(password: candidate, using: env.apiClient) {
                // A dashboard session carries no account identifier. Treat every
                // login as an account boundary before attempting a fresh fetch.
                await env.budgetStore.clearAll()
                await env.budgetStore.refresh()
                Haptics.success()
            } else {
                Haptics.error()
            }
        }
    }

    private func signOut() {
        Task {
            let serverLogoutSucceeded = await store.logout(using: env.apiClient)
            // APIClient always discards the local cookie, even when the server
            // cannot be reached, so cached money must be cleared in both paths.
            await env.budgetStore.clearAll()
            if serverLogoutSucceeded {
                Haptics.warning()
            } else {
                Haptics.error()
            }
        }
    }
}

private struct AccessCapabilityRow: View {
    let title: String
    let detail: String
    let systemImage: String
    let status: Theme.SemanticStatus

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(status.tint)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer()
            Image(systemName: status == .ok ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(status.tint)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title): \(detail)")
    }
}
