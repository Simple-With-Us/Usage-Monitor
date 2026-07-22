import Foundation

/// Where the app points and how it authenticates.
///
/// The default base URL is the production monitor. The host is overridable so
/// an operator can point the app at a staging deployment from Settings; the
/// chosen value is persisted by the app layer and passed in here.
public struct APIConfiguration: Sendable, Equatable {
    /// Base URL, e.g. `https://usage.jays.services`. Paths are appended to this.
    public var baseURL: URL

    /// Default request timeout in seconds.
    public var timeout: TimeInterval

    public init(baseURL: URL, timeout: TimeInterval = 20) {
        self.baseURL = baseURL
        self.timeout = timeout
    }

    /// The production monitor deployment.
    public static let production = APIConfiguration(
        baseURL: URL(string: "https://usage.jays.services")!
    )

    /// Build a configuration from a user-entered monitor origin. A missing
    /// scheme defaults to HTTPS; plaintext HTTP and URL credentials are never
    /// accepted because authenticated requests may carry a bearer token or an
    /// HttpOnly dashboard-session cookie.
    public static func fromUserInput(_ raw: String) -> APIConfiguration? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }

        guard var components = URLComponents(string: text),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty
        else {
            return nil
        }

        // Store an origin, not an arbitrary base path. Normalizing the scheme
        // and host also keeps settings comparisons/account cache scopes stable.
        components.scheme = "https"
        components.host = host.lowercased()
        guard let url = components.url else { return nil }
        return APIConfiguration(baseURL: url)
    }
}
