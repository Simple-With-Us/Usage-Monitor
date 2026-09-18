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
        case delete = "DELETE"
    }

    private static let dashboardSessionCookieName = "dashboard_session"

    private let configuration: APIConfiguration
    private let tokenStore: TokenStoring
    private let session: URLSession
    private let cookieStorage: HTTPCookieStorage?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    private static let sessionProbeCacheTTL: TimeInterval = 45
    private var sessionProbeCache: (status: DashboardSessionStatus, probedAt: Date)?

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

    /// `GET /api/quota-windows` — latest remaining-percent quota windows per
    /// provider (5h / 7d / 24h / monthly), bearer or dashboard-session
    /// authorized like the other read routes. Powers the Overview
    /// "Subscription Quotas" card.
    public func fetchQuotaWindows() async throws -> QuotaWindowsResponse {
        try await get("/api/quota-windows", authorization: .read)
    }

    /// `GET /api/health` — public liveness probe.
    public func health() async throws -> ServerHealth {
        try await get("/api/health", authorization: .none)
    }

    /// `GET /api/ready` — public readiness probe with dependency detail.
    public func readiness() async throws -> ServerReadiness {
        try await get("/api/ready", authorization: .none)
    }

    /// Cold `/api/server-metrics` / `/api/operations` / `/api/platform-status`
    /// fan out to Hetzner, Coolify, R2, and fleet backups.  A 20s default
    /// aborts those before the server can answer; keep the short timeout for
    /// ordinary reads.
    private static let operationsTimeout: TimeInterval = 60

    /// `GET /api/server-metrics` — Hetzner host + Coolify app inventory.
    /// Bearer read token or dashboard session.
    public func serverMetrics() async throws -> ServerMetrics {
        try await get("/api/server-metrics", authorization: .read, timeout: Self.operationsTimeout)
    }

    /// `GET /api/platform-status` — one status card per external platform the
    /// fleet runs on.  Bearer read token or dashboard session, same dual-auth
    /// preamble as `/api/server-metrics`.
    public func platformStatus() async throws -> PlatformStatusPayload {
        try await get("/api/platform-status", authorization: .read, timeout: Self.operationsTimeout)
    }

    /// `GET /api/operations` — fleet operations aggregator (receipt inbox,
    /// peer app health, Coolify fleet, R2 free tier, backup layers).  Bearer
    /// read token or dashboard session.
    public func operations() async throws -> OperationsHealth {
        try await get("/api/operations", authorization: .read, timeout: Self.operationsTimeout)
    }

    /// `GET /api/health/mac` — latest Mac heartbeat (CPU, memory, disk,
    /// process flags).  Bearer read token or dashboard session.
    public func macHealth() async throws -> MacHealthResponse {
        try await get("/api/health/mac", authorization: .read)
    }

    /// `GET /api/agents-overview?window=` — AI coding agent telemetry, live run
    /// status, subscription quotas, and PAYG API-equivalent cost savings.
    /// Bearer read token or dashboard session.
    ///
    /// Window is a query item, not a path suffix.  `endpoint(path:)` uses
    /// `appendingPathComponent`, which percent-encodes `?` (`%3F`).  Inlining
    /// `?window=` produced `/api/agents-overview%3Fwindow=30d`, a Next.js 404
    /// that the Agents tab surfaces as "Request failed".
    public func agentsOverview(window: String = "30d") async throws -> AgentsOverviewResponse {
        try await get(
            "/api/agents-overview",
            queryItems: [URLQueryItem(name: "window", value: window)],
            authorization: .read,
            timeout: Self.operationsTimeout
        )
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
        // A fresh cookie must never inherit a cached validation of an older one.
        sessionProbeCache = nil
        return response
    }

    /// Invalidate the server session and remove any matching local cookie.
    @discardableResult
    public func logout() async throws -> DashboardLogoutResponse {
        // Local sign-out is fail-closed: an offline/5xx server response may mean
        // the remote cookie remains valid until expiry, but this device must not
        // retain or reuse it after the user chose Sign Out.
        defer {
            sessionProbeCache = nil
            deleteDashboardSessionCookies()
        }
        return try await send(
            "/api/auth/logout",
            method: .post,
            authorization: .session,
            body: EmptyRequestBody()
        )
    }

    /// Validate the cookie against a session-gated endpoint. There is no
    /// dedicated server session-status route, so the probe is the cheapest
    /// bounded session-gated query available: one indexed `take` on
    /// `GET /api/usage-events?raw=1&limit=1&days=1`. The dashboard provider
    /// inventory (`?view=dashboard`) previously served as the probe, but it is
    /// the heaviest endpoint in the app and fired on every Settings appear;
    /// the public `/api/health` and `/api/ready` routes cannot validate a
    /// session because they answer 200 without one. Results are cached briefly
    /// so repeated Settings visits don't re-probe.
    public func sessionStatus() async throws -> DashboardSessionStatus {
        guard hasDashboardSessionCookie else {
            sessionProbeCache = nil
            return .signedOut
        }
        if let cache = sessionProbeCache,
           Date().timeIntervalSince(cache.probedAt) < Self.sessionProbeCacheTTL {
            return cache.status
        }
        do {
            try await probeDashboardSession()
            let status = DashboardSessionStatus.active(providerCount: nil)
            sessionProbeCache = (status: status, probedAt: Date())
            return status
        } catch APIError.unauthorized {
            deleteDashboardSessionCookies()
            sessionProbeCache = nil
            return .signedOut
        }
    }

    /// Forget any cached session validation. Called after login/logout and on
    /// host switches so a stale "active" can never survive a credential change.
    public func invalidateSessionStatusCache() {
        sessionProbeCache = nil
    }

    private struct SessionProbeResponse: Decodable {
        // Only the envelope marker is consumed; every field is optional so a
        // response-shape evolution can never turn a healthy probe into a
        // decoding failure.
        let mode: String?
    }

    private func probeDashboardSession() async throws {
        let _: SessionProbeResponse = try await get(
            "/api/usage-events",
            queryItems: [
                URLQueryItem(name: "raw", value: "1"),
                URLQueryItem(name: "limit", value: "1"),
                URLQueryItem(name: "days", value: "1"),
            ],
            authorization: .session
        )
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
            body: ProviderPlanUpdateRequest(
                plan: ProviderPlanUpdate(
                    preserving: provider.plan,
                    monthlyBudgetUsd: monthlyBudgetUsd
                )
            )
        )
    }

    /// Pause an active subscription. Note the server converts an
    /// `externalBillingManaged` row to owner-managed on ANY owner edit
    /// (including pause); the UI warns before calling this for such rows.
    @discardableResult
    public func pauseSubscription(id: String) async throws -> SubscriptionMutationReceipt {
        try await send(
            "/api/subscriptions/\(id)",
            method: .put,
            authorization: .session,
            body: SubscriptionStatusUpdate(status: "paused")
        )
    }

    /// Reactivate a paused/canceled/considering/expired subscription using the
    /// server's `activationMode` contract (`parseSubscriptionUpdateInput`):
    /// `resume` continues the paid-through term (previously charged rows only);
    /// `repurchase` anchors a fresh cycle at activation. `renewAutomatically`
    /// is sent only when the caller must also flip `autoRenew` (repurchasing an
    /// expired term requires it for the server to treat this as an activation).
    /// The response carries the new `nextRenewalAt`.
    @discardableResult
    public func activateSubscription(
        id: String,
        mode: SubscriptionActivationMode,
        renewAutomatically: Bool? = nil
    ) async throws -> SubscriptionMutationReceipt {
        try await send(
            "/api/subscriptions/\(id)",
            method: .put,
            authorization: .session,
            body: SubscriptionActivationUpdate(
                status: "active",
                activationMode: mode.rawValue,
                autoRenew: renewAutomatically
            )
        )
    }

    /// Submit the native plan editor's full form state. Editable fields use
    /// clear-on-nil semantics (JSON null clears the stored value); the plan
    /// fields the editor does not manage (`monthlyRequestLimit`,
    /// `lowBalanceUsd`, `lowCredits`, `billingMode`, `mustKeepFunded`) are
    /// preserved from the inventory item exactly as the budget-only update
    /// does. The server rejects a positive `fixedMonthlyCostUsd` when an
    /// active/considering Subscription already models the same fee (400).
    @discardableResult
    public func updateProviderPlan(
        provider: ProviderManagementItem,
        patch: ProviderPlanPatch
    ) async throws -> ProviderMutationReceipt {
        try await send(
            "/api/providers/\(provider.id)",
            method: .put,
            authorization: .session,
            body: ProviderPlanUpdateRequest(
                plan: ProviderPlanUpdate(preserving: provider.plan, patch: patch)
            )
        )
    }

    /// `POST /api/providers/:id/fetch` — record a fresh usage snapshot
    /// immediately instead of waiting for the next scheduled poll. Returns the
    /// stored snapshot (201). Server error bodies carry `{error, code,
    /// retryable}`; non-retryable adapter/config failures arrive as 4xx and
    /// surface as typed `APIError`s like any other mutation.
    @discardableResult
    public func fetchProviderNow(id: String) async throws -> ProviderFetchReceipt {
        try await send(
            "/api/providers/\(id)/fetch",
            method: .post,
            authorization: .session,
            body: EmptyRequestBody()
        )
    }

    // MARK: - Project management (session-only)

    /// `POST /api/projects` — create a project. Session-cookie-only by server
    /// policy (the route re-checks the dashboard session even though the
    /// middleware already gates it). `description`/`monthlyBudgetUsd` are
    /// omitted when nil; the server rejects a duplicate or case-equivalent
    /// `name` with 400/409 (surfaced as typed `APIError`s).
    @discardableResult
    public func createProject(
        name: String,
        description: String?,
        monthlyBudgetUsd: Double?
    ) async throws -> ProjectMutationReceipt {
        try await send(
            "/api/projects",
            method: .post,
            authorization: .session,
            body: ProjectCreateRequest(
                name: name,
                description: description,
                monthlyBudgetUsd: monthlyBudgetUsd
            )
        )
    }

    /// `PUT /api/projects/:id` — update name/description/budget. Follows the
    /// server's field semantics: `description` is always sent (a blank string
    /// clears the stored value server-side); `monthlyBudgetUsd` encodes an
    /// explicit JSON null when nil so a cleared budget is actually cleared
    /// (an omitted key would preserve the old value).
    @discardableResult
    public func updateProject(
        id: String,
        name: String,
        description: String,
        monthlyBudgetUsd: Double?
    ) async throws -> ProjectMutationReceipt {
        try await send(
            "/api/projects/\(id)",
            method: .put,
            authorization: .session,
            body: ProjectUpdateRequest(
                name: name,
                description: description,
                monthlyBudgetUsd: monthlyBudgetUsd
            )
        )
    }

    /// `DELETE /api/projects/:id` — remove a project. Usage history survives;
    /// the server set-nulls `projectId` on tagged events.
    @discardableResult
    public func deleteProject(id: String) async throws -> ProjectDeleteReceipt {
        try await sendWithoutBody(
            "/api/projects/\(id)",
            method: .delete,
            authorization: .session
        )
    }

    /// `DELETE /api/providers/:id` — remove a provider. Infisical-managed and
    /// key-attribution-history providers return 409.
    @discardableResult
    public func deleteProvider(id: String) async throws -> ProviderDeleteReceipt {
        try await sendWithoutBody(
            "/api/providers/\(id)",
            method: .delete,
            authorization: .session
        )
    }

    /// `DELETE /api/subscriptions/:id` — remove a tracked subscription row.
    @discardableResult
    public func deleteSubscription(id: String) async throws -> SubscriptionDeleteReceipt {
        try await sendWithoutBody(
            "/api/subscriptions/\(id)",
            method: .delete,
            authorization: .session
        )
    }

    // MARK: - Provider read depth (session-only)

    /// `GET /api/snapshots?providerId=&days=` — real recorded usage history
    /// (raw points plus server-synthesized daily rollups past the raw
    /// retention cutoff), chronological. Session-gated by the middleware
    /// allow-list, so this throws `APIError.unauthorized` (401) when no
    /// dashboard session is active. `days` defaults to the web-parity
    /// 30-day window; callers pass `SnapshotHistoryRange.days` for the
    /// 7 / 30 / 90 / 365 control.
    public func usageSnapshots(
        providerID: String,
        days: Int = SnapshotHistoryRange.default.days
    ) async throws -> [UsageSnapshotPoint] {
        let clampedDays = min(max(days, 1), 3_650)
        return try await get(
            "/api/snapshots",
            queryItems: [
                URLQueryItem(name: "providerId", value: providerID),
                URLQueryItem(name: "days", value: String(clampedDays)),
            ],
            authorization: .session
        )
    }

    /// `GET /api/providers/:id` — the bounded detail payload carrying
    /// provider-reported external billing records. Session-gated like the
    /// inventory route.
    public func providerDetail(id: String) async throws -> ProviderDetailRecord {
        try await get("/api/providers/\(id)", authorization: .session)
    }

    /// `POST /api/apns/device-tokens` — upload native APNs device token for push notifications.
    
    // MARK: - Intelligence (session-only analytics)

    public func llmBurn(hours: Int = 5) async throws -> LlmBurnResponse {
        let clamped = min(max(hours, 1), 24)
        return try await get(
            "/api/llm-burn",
            queryItems: [URLQueryItem(name: "hours", value: String(clamped))],
            authorization: .session
        )
    }

    public func registerApnsDeviceToken(
        deviceToken: String,
        deviceModel: String? = nil,
        osVersion: String? = nil,
        environment: String? = nil
    ) async throws {
        struct RegisterPayload: Encodable {
            let deviceToken: String
            let deviceModel: String?
            let osVersion: String?
            let environment: String?
        }
        struct RegisterResponse: Decodable {
            let ok: Bool
        }
        let _: RegisterResponse = try await send(
            "/api/apns/device-tokens",
            method: .post,
            authorization: .session,
            body: RegisterPayload(
                deviceToken: deviceToken,
                deviceModel: deviceModel,
                osVersion: osVersion,
                environment: environment
            )
        )
    }


    public func claudeCostCheck(days: Int = 30) async throws -> ClaudeCostCheckResponse {
        let clamped = min(max(days, 1), 3650)
        return try await get(
            "/api/claude-cost-check",
            queryItems: [URLQueryItem(name: "days", value: String(clamped))],
            authorization: .session
        )
    }

    public func keyAttribution() async throws -> KeyAttributionResponse {
        try await get("/api/key-attribution", authorization: .session)
    }

    /// `GET /api/usage-events` summary for the Overview chart-range card.
    /// Session-gated (dashboard password). Query items come from
    /// `TimeframeOption.usageEventsQueryItems` so changing the range reloads.
    public func usageEventsSummary(
        queryItems: [URLQueryItem]
    ) async throws -> UsageEventsSummary {
        try await get(
            "/api/usage-events",
            queryItems: queryItems,
            authorization: .session
        )
    }

    /// `GET /api/export/daily-rollups` — the daily spend series behind the
    /// Overview chart-range card for any selection other than "This month"
    /// (which shows the month-to-date pace chart instead). Session-gated,
    /// same as `usageEventsSummary`. `from`/`to` are inclusive UTC calendar
    /// days (`yyyy-MM-dd`); the route rejects windows over 92 days, so
    /// callers should pre-clamp (see `TimeframeOption.dailyRollupWindow`).
    public func dailyRollups(from: String, to: String) async throws -> DailyRollupsResponse {
        try await get(
            "/api/export/daily-rollups",
            queryItems: [
                URLQueryItem(name: "from", value: from),
                URLQueryItem(name: "to", value: to),
            ],
            authorization: .session
        )
    }

    // MARK: - Request plumbing

    private func get<T: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem] = [],
        authorization: AuthorizationMode,
        requireBearer: Bool = false,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        let request = try makeRequest(
            path: path,
            queryItems: queryItems,
            method: .get,
            authorization: authorization,
            requireBearer: requireBearer,
            timeout: timeout
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

    private func sendWithoutBody<Response: Decodable>(
        _ path: String,
        method: Method,
        authorization: AuthorizationMode
    ) async throws -> Response {
        let request = try makeRequest(
            path: path,
            method: method,
            authorization: authorization
        )
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
        requireBearer: Bool = false,
        timeout: TimeInterval? = nil
    ) throws -> URLRequest {
        let url = try endpoint(path: path, queryItems: queryItems)
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: timeout ?? configuration.timeout
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

private struct ProviderPlanUpdateRequest: Encodable {
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
    /// Fields the editor submitted with clear-on-nil semantics: nil encodes an
    /// explicit JSON null (clear) instead of an omitted key (preserve).
    let clearableKeys: Set<CodingKeys>

    /// Budget-only edit: every field except `monthlyBudgetUsd` is preserved.
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
        clearableKeys = [.monthlyBudgetUsd]
    }

    /// Full plan-editor submission: the editable fields follow the patch's
    /// clear-on-nil semantics; the rest round-trip from the inventory item.
    init(preserving plan: ProviderManagementItem.Plan?, patch: ProviderPlanPatch) {
        billingMode = plan?.billingMode ?? "manual"
        fixedMonthlyCostUsd = patch.fixedMonthlyCostUsd
        monthlyBudgetUsd = patch.monthlyBudgetUsd
        monthlyRequestLimit = plan?.monthlyRequestLimit
        lowBalanceUsd = plan?.lowBalanceUsd
        lowCredits = plan?.lowCredits
        renewalDate = patch.renewalDate
        billingInterval = patch.billingInterval
        mustKeepFunded = plan?.mustKeepFunded ?? false
        notes = patch.notes
        clearableKeys = [.fixedMonthlyCostUsd, .monthlyBudgetUsd, .renewalDate, .billingInterval, .notes]
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
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
        try encodeClearable(fixedMonthlyCostUsd, forKey: .fixedMonthlyCostUsd, in: &container)
        try encodeClearable(monthlyBudgetUsd, forKey: .monthlyBudgetUsd, in: &container)
        try container.encodeIfPresent(monthlyRequestLimit, forKey: .monthlyRequestLimit)
        try container.encodeIfPresent(lowBalanceUsd, forKey: .lowBalanceUsd)
        try container.encodeIfPresent(lowCredits, forKey: .lowCredits)
        try encodeClearable(renewalDate, forKey: .renewalDate, in: &container)
        try encodeClearable(billingInterval, forKey: .billingInterval, in: &container)
        try container.encode(mustKeepFunded, forKey: .mustKeepFunded)
        try encodeClearable(notes, forKey: .notes, in: &container)
    }

    /// Editable fields: present → value; nil → explicit JSON null so the
    /// server CLEARS the stored value. Non-editable fields use
    /// `encodeIfPresent` so a nil there preserves the server value.
    private func encodeClearable<T: Encodable>(
        _ value: T?,
        forKey key: CodingKeys,
        in container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        if let value {
            try container.encode(value, forKey: key)
        } else if clearableKeys.contains(key) {
            try container.encodeNil(forKey: key)
        }
    }
}

private struct SubscriptionStatusUpdate: Encodable {
    let status: String
}

/// `POST /api/projects` body. The server reads exactly `name`, `description`,
/// and `monthlyBudgetUsd`; nil optionals are omitted (absent keys simply leave
/// the column unset on create).
private struct ProjectCreateRequest: Encodable {
    let name: String
    let description: String?
    let monthlyBudgetUsd: Double?
}

/// `PUT /api/projects/:id` body. `description` is always sent: the server
/// trims it and stores null for a blank string, so editing the field down to
/// empty really clears it. `monthlyBudgetUsd` uses explicit-null semantics —
/// nil must encode JSON null (clear), not an omitted key (preserve).
private struct ProjectUpdateRequest: Encodable {
    let name: String
    let description: String
    let monthlyBudgetUsd: Double?

    private enum CodingKeys: String, CodingKey {
        case name
        case description
        case monthlyBudgetUsd
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(description, forKey: .description)
        if let monthlyBudgetUsd {
            try container.encode(monthlyBudgetUsd, forKey: .monthlyBudgetUsd)
        } else {
            try container.encodeNil(forKey: .monthlyBudgetUsd)
        }
    }
}

private struct SubscriptionActivationUpdate: Encodable {
    let status: String
    let activationMode: String
    let autoRenew: Bool?

    private enum CodingKeys: String, CodingKey {
        case status
        case activationMode
        case autoRenew
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(activationMode, forKey: .activationMode)
        // autoRenew is only sent when the caller must flip it (e.g. repurchasing
        // an expired term); omitting it preserves the stored value.
        try container.encodeIfPresent(autoRenew, forKey: .autoRenew)
    }
}
