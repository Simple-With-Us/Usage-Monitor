import SwiftUI
import AppCore
import DesignSystem
import Networking
#if canImport(UIKit)
import UIKit
#endif

/// The server-address + API-token entry, the heart of the Settings screen.
/// Verifies a token before it is ever written to the Keychain and keeps the
/// flow forgiving: paste support, reveal toggle, inline typed errors, and a
/// "save anyway" escape hatch when the server (not the token) is at fault.
struct ConnectionSection: View {
    @Bindable var model: SettingsViewModel
    @FocusState private var tokenFocused: Bool

    var body: some View {
        // MARK: Server address
        Section {
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "network")
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .accessibilityHidden(true)
                TextField("usage.jays.services", text: $model.hostInput)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .accessibilityLabel("Server address")
                    .accessibilityHint("Leave empty for the default monitor")
                if !model.trimmedHost.isEmpty {
                    Button {
                        model.resetHost()
                    } label: {
                        Image(systemName: "arrow.uturn.backward.circle.fill")
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Reset to default server")
                }
            }

            if model.hostChanged && model.hasStoredToken {
                Button {
                    model.applyHostChange()
                } label: {
                    Label("Apply server change", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(!model.isHostValid)
            }
        } header: {
            Text("Server")
        } footer: {
            if !model.isHostValid {
                Text("Enter a secure HTTPS monitor address with no path, query, or sign-in details.")
                    .foregroundStyle(Theme.Colors.danger)
            } else {
                Text("Requests go securely to \(model.resolvedHostDisplay). Leave empty to use the default monitor.")
            }
        }

        // MARK: API token
        Section {
            statusRow
            tokenField
            connectButton
            if model.hasStoredToken {
                Button(role: .destructive) {
                    model.showRemoveConfirmation = true
                } label: {
                    Label("Remove token", systemImage: "trash")
                }
            }
        } header: {
            Text("API Token")
        } footer: {
            footerContent
        }
        .confirmationDialog(
            "Remove the stored API token?",
            isPresented: $model.showRemoveConfirmation,
            titleVisibility: .visible
        ) {
            Button("Remove token", role: .destructive) { model.removeToken() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Budget data will stop loading until you enter a token again. The token is only stored on this device.")
        }
    }

    // MARK: - Pieces

    @ViewBuilder
    private var statusRow: some View {
        switch model.phase {
        case .verified:
            HStack {
                Label {
                    Text("Connected")
                        .foregroundStyle(Theme.Colors.primaryText)
                } icon: {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(Theme.Colors.success)
                }
                Spacer()
                StatusBadge("Verified", status: .ok)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Connected. Token verified.")

        case .configured:
            HStack {
                Label {
                    Text("Token configured")
                        .foregroundStyle(Theme.Colors.primaryText)
                } icon: {
                    Image(systemName: "key.fill")
                        .foregroundStyle(Theme.Colors.accent)
                }
                Spacer()
                StatusBadge("Not checked", status: .neutral)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("API token configured, not verified this session")

        case .verifying:
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView()
                Text("Verifying token…")
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Verifying token")

        case let .failed(error):
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.Colors.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(error.title)
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(error.message)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(error.title). \(error.message)")

        case .idle:
            EmptyView()
        }
    }

    private var tokenField: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "key.fill")
                .foregroundStyle(Theme.Colors.secondaryText)
                .accessibilityHidden(true)

            Group {
                if model.isTokenRevealed {
                    TextField(tokenPlaceholder, text: $model.tokenInput)
                } else {
                    SecureField(tokenPlaceholder, text: $model.tokenInput)
                }
            }
            .textContentType(.password)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .font(.system(.body, design: .monospaced))
            .focused($tokenFocused)
            .submitLabel(.go)
            .onSubmit { Task { await model.connect() } }
            .accessibilityLabel("API token")

            if !model.tokenInput.isEmpty {
                Button {
                    model.isTokenRevealed.toggle()
                    Haptics.selection()
                } label: {
                    Image(systemName: model.isTokenRevealed ? "eye.slash.fill" : "eye.fill")
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.isTokenRevealed ? "Hide token" : "Show token")
            } else if pasteboardHasString {
                Button {
                    pasteFromClipboard()
                } label: {
                    Image(systemName: "doc.on.clipboard")
                        .foregroundStyle(Theme.Colors.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Paste token")
            }
        }
    }

    private var connectButton: some View {
        Button {
            tokenFocused = false
            Task { await model.connect() }
        } label: {
            HStack {
                Spacer()
                if model.isBusy {
                    ProgressView().tint(.white)
                } else {
                    Label(connectTitle, systemImage: "checkmark.shield.fill")
                        .font(Theme.Typography.callout.weight(.semibold))
                }
                Spacer()
            }
            .padding(.vertical, Theme.Spacing.xs)
        }
        .listRowInsets(EdgeInsets(top: Theme.Spacing.sm, leading: Theme.Spacing.lg, bottom: Theme.Spacing.sm, trailing: Theme.Spacing.lg))
        .buttonStyle(.borderedProminent)
        .tint(Theme.Colors.accent)
        .disabled(!model.canConnect)
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private var footerContent: some View {
        if model.hasStoredToken {
            Text("Your token is stored securely in the device Keychain, never in iCloud or backups. Enter a new one above to replace it.")
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("Paste your monitor's read token to load budgets. It is verified before being saved to the Keychain and is never stored in plain text.")
                if let url = monitorURL {
                    Link(destination: url) {
                        Label("Where do I find my token?", systemImage: "questionmark.circle")
                            .font(Theme.Typography.caption)
                    }
                }
            }
        }
    }

    /// A link to the monitor the user is pointed at, so a first-run user can go
    /// mint / copy a read token instead of guessing where it comes from.
    private var monitorURL: URL? {
        URL(string: "https://\(model.resolvedHostDisplay)/settings")
    }

    private var connectTitle: String {
        model.hasStoredToken ? "Verify & Replace" : "Verify & Connect"
    }

    private var tokenPlaceholder: String {
        model.hasStoredToken ? "Enter a new token" : "Paste your API token"
    }

    /// Whether the clipboard holds *any* string — checked with `hasStrings`,
    /// which does NOT read the contents, so it never triggers iOS's "pasted
    /// from…" transparency banner. The actual `.string` read happens only when
    /// the user taps Paste (see ``pasteFromClipboard()``), so the banner appears
    /// once, on an explicit action, instead of on every re-render of `body`.
    private var pasteboardHasString: Bool {
        #if canImport(UIKit)
        return UIPasteboard.general.hasStrings
        #else
        return false
        #endif
    }

    private func pasteFromClipboard() {
        #if canImport(UIKit)
        guard let clipboard = UIPasteboard.general.string, !clipboard.isEmpty else { return }
        model.tokenInput = clipboard
        Haptics.selection()
        #endif
    }
}
