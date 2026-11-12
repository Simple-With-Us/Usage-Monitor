import Foundation
import Observation
import Models
import Networking

typealias ManagementMutationHandler = @MainActor () async -> Void

@MainActor
@Observable
final class ManagementAccessStore {
    private(set) var capabilities = AccessCapabilities(
        bearerRead: .notConfigured,
        sessionManagement: .signedOut
    )
    private(set) var isLoading = false
    private(set) var isAuthenticating = false
    private(set) var error: APIError?
    private var didLoad = false
    private var identityGeneration: UInt = 0

    /// Cross the host/bearer identity boundary synchronously. Any older probe
    /// may still finish at the transport layer, but its generation can no longer
    /// publish capabilities for the replacement client.
    func resetForIdentityChange() {
        identityGeneration &+= 1
        capabilities = AccessCapabilities(
            bearerRead: .notConfigured,
            sessionManagement: .signedOut
        )
        isLoading = false
        isAuthenticating = false
        error = nil
        didLoad = false
    }

    func loadIfNeeded(using client: APIClient) async {
        guard !didLoad else { return }
        await refresh(using: client)
    }

    func refresh(using client: APIClient) async {
        guard !isLoading, !isAuthenticating else { return }
        let generation = identityGeneration
        isLoading = true
        defer {
            if generation == identityGeneration { isLoading = false }
        }
        do {
            let capabilities = try await client.accessCapabilities()
            guard generation == identityGeneration else { return }
            self.capabilities = capabilities
            error = nil
            didLoad = true
        } catch is CancellationError {
            return
        } catch let apiError as APIError {
            guard generation == identityGeneration else { return }
            error = apiError
        } catch {
            guard generation == identityGeneration else { return }
            self.error = .transport(error.localizedDescription)
        }
    }

    func login(password: String, using client: APIClient) async -> Bool {
        guard !isAuthenticating else { return false }
        let generation = identityGeneration
        isAuthenticating = true
        error = nil
        defer {
            if generation == identityGeneration { isAuthenticating = false }
        }
        do {
            let response = try await client.login(password: password)
            guard generation == identityGeneration else { return false }
            guard response.ok else { throw APIError.unauthorized }
            let status = try await client.sessionStatus()
            guard generation == identityGeneration else { return false }
            guard status.isActive else { throw APIError.unauthorized }
            capabilities = AccessCapabilities(
                bearerRead: await client.hasToken ? .configured : .notConfigured,
                sessionManagement: status
            )
            didLoad = true
            return true
        } catch let apiError as APIError {
            guard generation == identityGeneration else { return false }
            error = apiError
            return false
        } catch {
            guard generation == identityGeneration else { return false }
            self.error = .transport(error.localizedDescription)
            return false
        }
    }

    func logout(using client: APIClient) async -> Bool {
        guard !isAuthenticating else { return false }
        let generation = identityGeneration
        isAuthenticating = true
        error = nil
        defer {
            if generation == identityGeneration {
                capabilities = AccessCapabilities(
                    bearerRead: capabilities.bearerRead,
                    sessionManagement: .signedOut
                )
                didLoad = true
                isAuthenticating = false
            }
        }
        do {
            _ = try await client.logout()
            guard generation == identityGeneration else { return false }
            return true
        } catch let apiError as APIError {
            guard generation == identityGeneration else { return false }
            error = apiError
            return false
        } catch {
            guard generation == identityGeneration else { return false }
            self.error = .transport(error.localizedDescription)
            return false
        }
    }
}
