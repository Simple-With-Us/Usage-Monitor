import Foundation
import Observation
import AppCore
import Networking

/// The phase of the token-connection flow, driving the connect button and the
/// inline status row.
enum ConnectionPhase: Equatable {
    case idle           // no token stored, nothing entered
    case configured     // token exists, but was not verified in this process
    case verifying      // a candidate token is being validated
    case verified       // a live request verified the stored token
    case failed(APIError)
}

/// View-model for the Settings screen. Owns the token/host input fields and the
/// connection flow, and mediates every write to the shared `AppEnvironment`
/// (Keychain token, base-host reconfigure). Appearance and app-lock toggles
/// bind straight to `env.settings`, so they live in the views, not here.
@MainActor
@Observable
final class SettingsViewModel {
    // MARK: Inputs
    var tokenInput: String = ""
    var hostInput: String = ""
    var isTokenRevealed: Bool = false
    var showRemoveConfirmation: Bool = false

    // MARK: Output
    private(set) var phase: ConnectionPhase = .idle

    private let verifier: TokenVerifying
    private var env: AppEnvironment?
    private var didBind = false

    init(verifier: TokenVerifying = LiveTokenVerifier()) {
        self.verifier = verifier
    }

    /// Wire the view-model to the shared environment. Idempotent — the initial
    /// call seeds the host field and connection phase from persisted state; the
    /// user's in-progress edits are never overwritten on later calls.
    func bind(to env: AppEnvironment) {
        self.env = env
        guard !didBind else { return }
        didBind = true
        hostInput = env.settings.baseHost
        phase = env.hasToken ? .configured : .idle
    }

    // MARK: Derived state

    var hasStoredToken: Bool { env?.hasToken ?? false }

    var isBusy: Bool { phase == .verifying }

    var trimmedToken: String {
        tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var trimmedHost: String {
        hostInput.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canConnect: Bool { !trimmedToken.isEmpty && isHostValid && !isBusy }

    /// Whether the host field currently parses to a valid configuration (empty
    /// is valid — it means the production default).
    var isHostValid: Bool {
        trimmedHost.isEmpty || APIConfiguration.fromUserInput(trimmedHost) != nil
    }

    /// The resolved host to display (production default when the field is empty).
    var resolvedHostDisplay: String {
        guard !trimmedHost.isEmpty else { return "usage.jays.services" }
        return APIConfiguration.fromUserInput(trimmedHost)?.baseURL.host ?? trimmedHost
    }

    /// True when the host field differs from what's persisted, so the UI can
    /// offer to apply a host change on its own (without re-entering the token).
    var hostChanged: Bool {
        guard let env else { return false }
        return trimmedHost != env.settings.baseHost
    }

    /// The current failure, if any, for inline presentation.
    var failure: APIError? {
        if case let .failed(error) = phase { return error }
        return nil
    }

    // MARK: Actions

    /// Verify the entered token against the (possibly overridden) host and, on
    /// success, persist it to the Keychain and repaint budget data.
    func connect() async {
        guard let env else { return }
        let token = trimmedToken
        guard !token.isEmpty else { phase = .failed(.missingToken); return }
        guard isHostValid else {
            phase = .failed(.transport("That server address isn't a valid URL."))
            return
        }

        phase = .verifying
        do {
            try await verifier.verify(token: token, host: hostInput)
            try persist(token: token, env: env)
            phase = .verified
            Haptics.success()
        } catch let error as APIError {
            phase = .failed(error)
            Haptics.error()
        } catch let error as TokenStoreError {
            phase = .failed(.transport(keychainMessage(error)))
            Haptics.error()
        } catch {
            phase = .failed(.transport(error.localizedDescription))
            Haptics.error()
        }
    }

    /// Remove the stored token (sign out). Clears the field, budget store,
    /// disk cache, and widget snapshot so the prior account's money never lingers.
    func removeToken() {
        guard let env else { return }
        try? env.setToken(nil)
        tokenInput = ""
        isTokenRevealed = false
        phase = .idle
        Task { await env.budgetStore.clearAll() }
        Haptics.warning()
    }

    /// Apply a base-host change on its own, keeping the existing token.
    func applyHostChange() {
        guard let env, isHostValid, hostChanged else { return }
        applyHostIfNeeded(env: env)
        scheduleBudgetReload(env)
        Haptics.success()
    }

    /// Reset the host field back to the production default.
    func resetHost() {
        hostInput = ""
        Haptics.selection()
    }

    // MARK: Private

    private func persist(token: String, env: AppEnvironment) throws {
        applyHostIfNeeded(env: env)
        try env.setToken(token)
        tokenInput = ""
        isTokenRevealed = false
        scheduleBudgetReload(env)
    }

    /// Kick a background budget refresh so the other tabs repaint with the new
    /// credential — fire-and-forget so the connect action feels instant and
    /// never blocks on a full fetch.
    private func scheduleBudgetReload(_ env: AppEnvironment) {
        Task { await env.budgetStore.refresh() }
    }

    private func applyHostIfNeeded(env: AppEnvironment) {
        let newHost = trimmedHost
        guard newHost != env.settings.baseHost else { return }
        env.settings.baseHost = newHost
        env.reconfigure(host: newHost)
    }

    private func keychainMessage(_ error: TokenStoreError) -> String {
        switch error {
        case .encoding:
            return "The token contained characters that couldn't be stored."
        case let .keychain(status):
            return "Couldn't save to the Keychain (code \(status))."
        }
    }
}
