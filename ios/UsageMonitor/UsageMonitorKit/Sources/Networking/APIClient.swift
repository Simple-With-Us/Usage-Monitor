import Foundation
import Models

/// The single entry point for all network access.
///
/// Read access and dashboard management access are deliberately separate:
/// a bearer token may read the bounded budget/subscription endpoints, while
/// provider and subscription mutations require the server's HttpOnly dashboard
/// session cookie. The dashboard password is accepted only as a login method
/// argument and is never retained by this actor.
public actor APIClient {
    private enum AuthorizationMode {
        case none
        case read
        case session
    }

    private enum Method: String {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
    }

    private static let dashboardSessionCookieName = "dashboard_session"

    private let configuration: APIConfiguration
    private let tokenStore: TokenStoring
    private let session: URLSession
    private let cookieStorage: HTTPCookieStorage?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        configuration: APIConfiguration = .production,
        tokenStore: TokenStoring = KeychainTokenStore(),
        session: URLSession? = nil
    ) {
        self.configuration = configuration
        self.tokenStore = tokenStore

        if let session {
            self.session = session
            self.cookieStorage = session.configuration.httpCookieStorage
        } else {
            let sessionConfiguration = URLSessionConfiguration.default
            sessionConfiguration.httpShouldSetCookies = true
            sessionConfiguration.httpCookieAcceptPolicy = .onlyFromMainDocumentDomain
            sessionConfiguration.httpCookieStorage = .shared
            self.session = URLSession(configuration: sessionConfiguration)
            self.cookieStorage = sessionConfiguration.httpCookieStorage
        }

        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    /// Whether a bearer read credential is currently stored.
    public var hasToken: Bool {
        tokenStore.hasToken
    }

    // MARK: - Read and public endpoints

    /// `GET /api/budget-status` — bearer or dashboard-session authorized.
    public func budgetStatus() async throws -> BudgetStatusResponse {
        try await get("/api/budget-status", authorization: .read)
    }

    /// `GET /api/subscriptions` — bearer or dashboard-session authorized.
    public func subscriptions() async throws -> [SubscriptionSummary] {
        try await get("/api/subscriptions", authorization: .read)
    }

    /// `GET /api/health` — public liveness probe.
    public func health() async throws -> ServerHealth {
        try await get("/api/health", authorization: .none)
    }

    /// `GET /api/ready` — public readiness probe with dependency detail.
    public func readiness() async throws -> ServerReadiness {
        try await get("/api/ready", authorization: .none)
    }

    /// Validate the currently stored bearer token without accepting a dashboard
    /// cookie as a substitute. Settings uses a disposable client for candidate
    /// tokens, so a stale cookie cannot make an invalid replacement look valid.
    @discardableResult
    public func verifyToken() async throws -> BudgetStatusResponse {
        try await get("/api/budget-status", authorization: .read, requireBearer: true)
    }

    // MARK: - Dashboard session

    /// Establish the HttpOnly dashboard session. `password` is encoded directly
    /// into the one request body and is never assigned to actor state.
    @discardableResult
    public func login(password: String) async throws -> DashboardLoginResponse {
        let response: DashboardLoginResponse = try await send(
            "/api/auth/login",
            method: .post,
            authorization: .none,
            body: DashboardLoginRequest(password: password)
        )
        return response
    }

    /// Invalidate the server session and remove any matching local cookie.
    @discardableResult
    public func logout() async throws -> DashboardLogoutResponse {
        // Local sign-out is fail-closed: an offline/5xx server response may mean
        // the remote cookie remains valid until expiry, but this device must not
        // retain or reuse it after the user chose Sign Out.
        defer { deleteDashboardSessionCookies() }
        return try await send(
            "/api/auth/logout",
            method: .post,
            authorization: .session,
            body: EmptyRequestBody()
        )
    }

    /// Validate the cookie against a session-gated endpoint. There is no
    /// dedicated server session-status route, so the bounded dashboard provider
    /// inventory is the authoritative probe and also gives Settings a useful
    /// provider count.
    public func sessionStatus() async throws -> DashboardSessionStatus {
        guard hasDashboardSessionCookie else { return .signedOut }
        do {
            let providers = try await providerInventory()
            return .active(providerCount: providers.count)
        } catch APIError.unauthorized {
            deleteDashboardSessionCookies()
            return .signedOut
        }
    }

    /// Local bearer configuration plus server-validated dashboard-session state.
    public func accessCapabilities() async throws -> AccessCapabilities {
        AccessCapabilities(
            bearerRead: tokenStore.hasToken ? .configured : .notConfigured,
            sessionManagement: try await sessionStatus()
        )
    }

    // MARK: - Native management

    /// Rich provider inventory. Session-cookie-only by server policy.
    public func providerInventory() async throws -> [ProviderManagementItem] {
        try await get(
            "/api/providers",
            queryItems: [URLQueryItem(name: "view", value: "dashboard")],
            authorization: .session
        )
    }

    /// Safely toggle a provider. Infisical-managed providers remain protected
    /// by the server and are disabled in the native UI when advertised read-only.
    @discardableResult
    public func setProviderActive(
        id: String,
        isActive: Bool
    ) async throws -> ProviderMutationReceipt {
        try await send(
            "/api/providers/\(id)",
            method: .put,
            authorization: .session,
            body: ProviderActiveUpdate(isActive: isActive)
        )
    }

    /// Update only the monthly budget while round-tripping the plan fields whose
    /// server defaults would otherwise make a partial plan payload destructive.
    @discardableResult
    public func setProviderMonthlyBudget(
        provider: ProviderManagementItem,
        monthlyBudgetUsd: Double?
    ) async throws -> ProviderMutationReceipt {
        try await send(
            "/api/providers/\(provider.id)",
            method: .put,
            authorization: .session,
            body: ProviderBudgetUpdate(
                plan: ProviderPlanUpdate(
                    preserving: provider.plan,
                    monthlyBudgetUsd: monthlyBudgetUsd
                )
            )
        )
    }

    /// Pause an active subscription. Reactivation is intentionally not exposed:
    /// the server requires resume-vs-repurchase context absent from the list DTO.
    @discardableResult
    public func pauseSubscription(id: String) async throws -> SubscriptionMutationReceipt {
        try await send(
            "/api/subscriptions/\(id)",
            method: .put,
            authorization: .session,
            body: SubscriptionStatusUpdate(status: "paused")
        )
    }

    // MARK: - Request plumbing

    private func get<T: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem] = [],
        authorization: AuthorizationMode,
        requireBearer: Bool = false
    ) async throws -> T {
        let request = try makeRequest(
            path: path,
            queryItems: queryItems,
            method: .get,
            authorization: authorization,
            requireBearer: requireBearer
        )
        return try await execute(request)
    }

    private func send<Response: Decodable, Body: Encodable>(
        _ path: String,
        method: Method,
        authorization: AuthorizationMode,
        body: Body
    ) async throws -> Response {
        var request = try makeRequest(
            path: path,
            method: method,
            authorization: authorization
        )
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        return try await execute(request)
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let urlError as URLError {
            switch urlError.code {
            case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
                throw APIError.offline
            case .timedOut, .cannotConnectToHost, .networkConnectionLost, .cannotFindHost:
                throw APIError.transport(urlError.localizedDescription)
            default:
                throw APIError.transport(urlError.localizedDescription)
            }
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Malformed response")
        }
        storeResponseCookies(from: http, for: request.url)

        switch http.statusCode {
        case 200...299:
            break
        case 401:
            throw APIError.unauthorized
        case 403:
            throw APIError.forbidden
        case 429:
            let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            throw APIError.rateLimited(retryAfter: retryAfter)
        case 503:
            throw APIError.serverNotConfigured
        default:
            throw APIError.httpStatus(http.statusCode)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch let decodingError as DecodingError {
            throw APIError.decoding(Self.describe(decodingError))
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }

    private func makeRequest(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: Method,
        authorization: AuthorizationMode,
        requireBearer: Bool = false
    ) throws -> URLRequest {
        let url = try endpoint(path: path, queryItems: queryItems)
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: configuration.timeout
        )
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        switch authorization {
        case .none, .session:
            break
        case .read:
            if let token = trimmedBearerToken {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            } else if requireBearer || !hasDashboardSessionCookie {
                throw APIError.missingToken
            }
        }
        if requireBearer {
            // Defense in depth for candidate-token validation. The disposable
            // verifier already uses a cookie-free session, but this also keeps a
            // future injected/shared URLSession from silently authenticating the
            // request with a dashboard cookie instead of the bearer under test.
            request.httpShouldHandleCookies = false
        }
        return request
    }

    private func endpoint(path: String, queryItems: [URLQueryItem]) throws -> URL {
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let url = configuration.baseURL.appendingPathComponent(cleanPath)
        guard !queryItems.isEmpty else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIError.transport("Invalid request URL")
        }
        components.queryItems = queryItems
        guard let result = components.url else {
            throw APIError.transport("Invalid request URL")
        }
        return result
    }

    private var trimmedBearerToken: String? {
        guard let token = tokenStore.token()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    private var hasDashboardSessionCookie: Bool {
        dashboardSessionCookies.contains { cookie in
            if let expires = cookie.expiresDate, expires <= Date() { return false }
            return !cookie.value.isEmpty
        }
    }

    private var dashboardSessionCookies: [HTTPCookie] {
        (cookieStorage?.cookies(for: configuration.baseURL) ?? []).filter {
            $0.name == Self.dashboardSessionCookieName
        }
    }

    private func deleteDashboardSessionCookies() {
        Self.clearDashboardSessionCookies(
            for: configuration.baseURL,
            cookieStorage: cookieStorage
        )
    }

    /// Synchronously discard this app's dashboard session for an origin. Host
    /// switches call this before replacing the client so returning to an old
    /// server cannot silently resurrect management access from the shared jar.
    public nonisolated static func clearDashboardSessionCookies(
        for baseURL: URL,
        cookieStorage: HTTPCookieStorage? = .shared
    ) {
        for cookie in cookieStorage?.cookies(for: baseURL) ?? []
        where cookie.name == dashboardSessionCookieName {
            cookieStorage?.deleteCookie(cookie)
        }
    }

    /// Custom URLProtocol-backed test sessions do not always run Foundation's
    /// cookie acceptor, so explicitly applying response cookies makes the same
    /// behavior deterministic while remaining idempotent in production.
    private func storeResponseCookies(from response: HTTPURLResponse, for url: URL?) {
        guard let cookieStorage, let url else { return }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
            guard let key = entry.key as? String else { return }
            result[key] = String(describing: entry.value)
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        cookieStorage.setCookies(cookies, for: url, mainDocumentURL: configuration.baseURL)
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case let .keyNotFound(key, _):
            return "Missing field '\(key.stringValue)'."
        case let .typeMismatch(_, context):
            return context.debugDescription
        case let .valueNotFound(_, context):
            return context.debugDescription
        case let .dataCorrupted(context):
            return context.debugDescription
        @unknown default:
            return "Could not decode the response."
        }
    }
}

private struct DashboardLoginRequest: Encodable {
    let password: String
}

private struct EmptyRequestBody: Encodable {}

private struct ProviderActiveUpdate: Encodable {
    let isActive: Bool
}

private struct ProviderBudgetUpdate: Encodable {
    let plan: ProviderPlanUpdate
}

private struct ProviderPlanUpdate: Encodable {
    let billingMode: String
    let fixedMonthlyCostUsd: Double?
    let monthlyBudgetUsd: Double?
    let monthlyRequestLimit: Int?
    let lowBalanceUsd: Double?
    let lowCredits: Double?
    let renewalDate: String?
    let billingInterval: String?
    let mustKeepFunded: Bool
    let notes: String?

    init(preserving plan: ProviderManagementItem.Plan?, monthlyBudgetUsd: Double?) {
        billingMode = plan?.billingMode ?? "manual"
        fixedMonthlyCostUsd = plan?.fixedMonthlyCostUsd
        self.monthlyBudgetUsd = monthlyBudgetUsd
        monthlyRequestLimit = plan?.monthlyRequestLimit
        lowBalanceUsd = plan?.lowBalanceUsd
        lowCredits = plan?.lowCredits
        renewalDate = plan?.renewalDate
        billingInterval = plan?.billingInterval
        mustKeepFunded = plan?.mustKeepFunded ?? false
        notes = plan?.notes
    }

    private enum CodingKeys: String, CodingKey {
        case billingMode
        case fixedMonthlyCostUsd
        case monthlyBudgetUsd
        case monthlyRequestLimit
        case lowBalanceUsd
        case lowCredits
        case renewalDate
        case billingInterval
        case mustKeepFunded
        case notes
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(billingMode, forKey: .billingMode)
        try container.encodeIfPresent(fixedMonthlyCostUsd, forKey: .fixedMonthlyCostUsd)
        if let monthlyBudgetUsd {
            try container.encode(monthlyBudgetUsd, forKey: .monthlyBudgetUsd)
        } else {
            // `nil` is an intentional edit here, not an omitted field: the
            // server uses JSON null to clear an existing budget.
            try container.encodeNil(forKey: .monthlyBudgetUsd)
        }
        try container.encodeIfPresent(monthlyRequestLimit, forKey: .monthlyRequestLimit)
        try container.encodeIfPresent(lowBalanceUsd, forKey: .lowBalanceUsd)
        try container.encodeIfPresent(lowCredits, forKey: .lowCredits)
        try container.encodeIfPresent(renewalDate, forKey: .renewalDate)
        try container.encodeIfPresent(billingInterval, forKey: .billingInterval)
        try container.encode(mustKeepFunded, forKey: .mustKeepFunded)
        try container.encodeIfPresent(notes, forKey: .notes)
    }
}

private struct SubscriptionStatusUpdate: Encodable {
    let status: String
}
