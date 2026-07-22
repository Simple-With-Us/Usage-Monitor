import Foundation
import Networking

/// Validates a candidate API token **without disturbing the app's stored
/// credential**.
///
/// The shared `APIClient.verifyToken()` reads whatever token is already in the
/// Keychain, so it can't be used to test a freshly-typed token before deciding
/// whether to persist it. Instead, the live verifier spins up a throwaway
/// `APIClient` backed by an `InMemoryTokenStore` holding the candidate token
/// and makes the cheapest authenticated call. On success Settings persists the
/// token to the Keychain via `AppEnvironment.setToken`; on failure the Keychain
/// is never touched. This makes token entry forgiving — a mistyped token can
/// never clobber a working one.
///
/// The protocol lets previews and unit tests substitute a deterministic result.
protocol TokenVerifying: Sendable {
    /// Validate `token` against `host`. Returns normally on success; throws the
    /// mapped ``APIError`` (`.unauthorized`, `.serverNotConfigured`, `.offline`,
    /// …) otherwise.
    func verify(token: String, host: String) async throws
}

/// Production verifier: builds a disposable client for the (possibly overridden)
/// host and performs the standard `verifyToken()` probe against it.
struct LiveTokenVerifier: TokenVerifying {
    private let session: URLSession

    init(session: URLSession? = nil) {
        self.session = session ?? Self.makeCookieFreeSession()
    }

    func verify(token: String, host: String) async throws {
        let configuration = APIConfiguration.fromUserInput(host) ?? .production
        let client = APIClient(
            configuration: configuration,
            tokenStore: InMemoryTokenStore(token: token),
            session: session
        )
        try await client.verifyToken()
    }

    /// Candidate bearer validation must not inherit the dashboard session from
    /// the app-wide cookie jar. Otherwise the dual-auth budget route could
    /// accept the cookie and make an invalid replacement token look verified.
    static func makeCookieFreeSession(
        protocolClasses: [AnyClass]? = nil
    ) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        if let protocolClasses {
            configuration.protocolClasses = protocolClasses
        }
        return URLSession(configuration: configuration)
    }
}

/// Deterministic verifier for previews and tests.
struct StubTokenVerifier: TokenVerifying {
    let result: Result<Void, APIError>

    init(_ result: Result<Void, APIError> = .success(())) {
        self.result = result
    }

    func verify(token: String, host: String) async throws {
        // Simulate a brief round-trip so previews show the verifying state.
        try? await Task.sleep(nanoseconds: 250_000_000)
        try result.get()
    }
}
