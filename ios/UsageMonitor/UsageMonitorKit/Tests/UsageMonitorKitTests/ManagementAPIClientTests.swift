import Foundation
import XCTest
@testable import Models
@testable import Networking

final class ManagementAPIClientTests: XCTestCase {
    override func tearDown() {
        ManagementURLProtocol.handler = nil
        super.tearDown()
    }

    func testBearerReadAttachesAuthorizationAndDecodesBudget() async throws {
        let harness = makeHarness(token: "  read-token  ")
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/budget-status")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer read-token")
            return .json(Self.budgetJSON)
        }

        let response = try await harness.client.budgetStatus()

        XCTAssertEqual(response.month, "2026-07")
        XCTAssertEqual(response.summary.totalSpentUsd, 12.5)
    }

    func testSessionCookieCanReadAndManageWithoutBearer() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            switch request.url?.path {
            case "/api/budget-status":
                return .json(Self.budgetJSON)
            case "/api/providers":
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query, "view=dashboard")
                return .json(Self.providersJSON)
            default:
                return .json(["error": "unexpected"], status: 404)
            }
        }

        _ = try await harness.client.budgetStatus()
        let capabilities = try await harness.client.accessCapabilities()

        XCTAssertEqual(capabilities.bearerRead, .notConfigured)
        XCTAssertEqual(capabilities.sessionManagement, .active(providerCount: 1))
        XCTAssertTrue(capabilities.canRead)
        XCTAssertTrue(capabilities.canManage)
    }

    func testVerifyTokenRequiresBearerEvenWithSessionCookie() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)

        do {
            _ = try await harness.client.verifyToken()
            XCTFail("A dashboard cookie must not validate a candidate bearer token.")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingToken)
        }
    }

    func testVerifyTokenSuppressesDashboardCookieWhileCheckingBearer() async throws {
        let harness = makeHarness(token: "definitely-wrong-bearer")
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer definitely-wrong-bearer"
            )
            XCTAssertFalse(request.httpShouldHandleCookies)
            XCTAssertNil(
                request.value(forHTTPHeaderField: "Cookie"),
                "A valid dashboard session must not authenticate the bearer under test."
            )
            return .json(["error": "Unauthorized"], status: 401)
        }

        do {
            _ = try await harness.client.verifyToken()
            XCTFail("The wrong bearer must remain rejected even when the cookie jar has a valid session.")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized)
        }
    }

    func testLoginStoresSessionCookieAndPasswordIsNotReused() async throws {
        let harness = makeHarness()
        var requestNumber = 0
        ManagementURLProtocol.handler = { request in
            requestNumber += 1
            if requestNumber == 1 {
                XCTAssertEqual(request.url?.path, "/api/auth/login")
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(Self.jsonObject(request)["password"] as? String, "correct horse")
                return .json(
                    ["ok": true],
                    headers: ["Set-Cookie": "dashboard_session=session-value; Path=/; Secure; HttpOnly; SameSite=Lax"]
                )
            }

            XCTAssertEqual(request.url?.path, "/api/providers")
            XCTAssertNil(request.httpBody)
            XCTAssertFalse(String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("correct horse") ?? false)
            return .json(Self.providersJSON)
        }

        _ = try await harness.client.login(password: "correct horse")
        let status = try await harness.client.sessionStatus()

        XCTAssertEqual(status, .active(providerCount: 1))
        XCTAssertTrue(hasSessionCookie(in: harness))
    }

    func testLogoutDeletesCookieAfterSuccess() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/auth/logout")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(["ok": true])
        }

        _ = try await harness.client.logout()

        XCTAssertFalse(hasSessionCookie(in: harness))
    }

    func testLogoutDeletesCookieWhenServerFails() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { _ in .json(["error": "down"], status: 500) }

        do {
            _ = try await harness.client.logout()
            XCTFail("Expected the server error to remain visible.")
        } catch let error as APIError {
            XCTAssertEqual(error, .httpStatus(500))
        }

        XCTAssertFalse(hasSessionCookie(in: harness), "Local sign-out must be fail-closed.")
    }

    func testBudgetUpdatePreservesPlanFieldsAndUsesSessionOnly() async throws {
        let harness = makeHarness(token: "read-token")
        installSessionCookie(in: harness)
        let provider = try JSONDecoder().decode([ProviderManagementItem].self, from: Self.data(Self.providersJSON))[0]
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/providers/provider-1")
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let plan = (Self.jsonObject(request)["plan"] as? [String: Any]) ?? [:]
            XCTAssertEqual(plan["billingMode"] as? String, "manual")
            XCTAssertEqual(plan["monthlyBudgetUsd"] as? Double, 125)
            XCTAssertEqual(plan["fixedMonthlyCostUsd"] as? Double, 20)
            XCTAssertEqual(plan["monthlyRequestLimit"] as? Int, 5000)
            XCTAssertEqual(plan["mustKeepFunded"] as? Bool, true)
            XCTAssertEqual(plan["notes"] as? String, "production")
            return .json(Self.providerMutationJSON)
        }

        _ = try await harness.client.setProviderMonthlyBudget(provider: provider, monthlyBudgetUsd: 125)
    }

    func testBudgetUpdateEncodesExplicitNullToClearMonthlyBudget() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        let provider = try JSONDecoder().decode(
            [ProviderManagementItem].self,
            from: Self.data(Self.providersJSON)
        )[0]
        ManagementURLProtocol.handler = { request in
            let plan = (Self.jsonObject(request)["plan"] as? [String: Any]) ?? [:]
            XCTAssertTrue(plan.keys.contains("monthlyBudgetUsd"))
            XCTAssertTrue(
                plan["monthlyBudgetUsd"] is NSNull,
                "Clear must send JSON null; omitting the key preserves the old server value."
            )
            return .json(Self.providerMutationJSON)
        }

        _ = try await harness.client.setProviderMonthlyBudget(
            provider: provider,
            monthlyBudgetUsd: nil
        )
    }

    func testProviderToggleAndSubscriptionPauseUseBoundedPayloads() async throws {
        let harness = makeHarness(token: "read-token")
        installSessionCookie(in: harness)
        var requests = 0
        ManagementURLProtocol.handler = { request in
            requests += 1
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            if requests == 1 {
                XCTAssertEqual(request.url?.path, "/api/providers/provider-1")
                XCTAssertEqual(Self.jsonObject(request)["isActive"] as? Bool, false)
                XCTAssertEqual(Self.jsonObject(request).count, 1)
                return .json(Self.providerMutationJSON)
            }
            XCTAssertEqual(request.url?.path, "/api/subscriptions/subscription-1")
            XCTAssertEqual(Self.jsonObject(request) as NSDictionary, ["status": "paused"] as NSDictionary)
            return .json(Self.subscriptionMutationJSON)
        }

        _ = try await harness.client.setProviderActive(id: "provider-1", isActive: false)
        _ = try await harness.client.pauseSubscription(id: "subscription-1")
    }

    // MARK: - Harness

    private struct Harness {
        let client: APIClient
        let baseURL: URL
        let cookieStorage: HTTPCookieStorage
    }

    private func makeHarness(token: String? = nil) -> Harness {
        let baseURL = URL(string: "https://management-\(UUID().uuidString.lowercased()).example.test")!
        let cookieStorage = HTTPCookieStorage.shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ManagementURLProtocol.self]
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieStorage
        let session = URLSession(configuration: configuration)
        return Harness(
            client: APIClient(
                configuration: APIConfiguration(baseURL: baseURL, timeout: 2),
                tokenStore: InMemoryTokenStore(token: token),
                session: session
            ),
            baseURL: baseURL,
            cookieStorage: cookieStorage
        )
    }

    private func installSessionCookie(in harness: Harness) {
        let cookie = HTTPCookie(properties: [
            .domain: harness.baseURL.host!,
            .path: "/",
            .name: "dashboard_session",
            .value: "session-value",
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(3_600),
        ])!
        harness.cookieStorage.setCookie(cookie)
    }

    private func hasSessionCookie(in harness: Harness) -> Bool {
        harness.cookieStorage.cookies(for: harness.baseURL)?.contains {
            $0.name == "dashboard_session" && !$0.value.isEmpty
        } ?? false
    }

    private static func jsonObject(_ request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else {
            return [:]
        }
        return object
    }

    private static func data(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private static let budgetJSON: [String: Any] = [
        "ok": true,
        "generatedAt": "2026-07-21T12:00:00.000Z",
        "month": "2026-07",
        "providers": [],
        "projects": [],
        "summary": [
            "totalBudgetUsd": 100,
            "budgetedSpentUsd": 12.5,
            "unbudgetedSpentUsd": 0,
            "totalSpentUsd": 12.5,
            "estimatedApiEquivalentUsd": 12.5,
            "remainingUsd": 87.5,
            "percentUsed": 12.5,
            "overBudget": false,
            "warning": false,
        ],
    ]

    private static let providersJSON: [[String: Any]] = [[
        "id": "provider-1",
        "name": "openai",
        "displayName": "OpenAI",
        "type": "openai",
        "isActive": true,
        "refreshIntervalMin": 15,
        "plan": [
            "billingMode": "manual",
            "fixedMonthlyCostUsd": 20,
            "monthlyBudgetUsd": 100,
            "monthlyRequestLimit": 5000,
            "lowBalanceUsd": 10,
            "lowCredits": 5,
            "renewalDate": "2026-08-01",
            "billingInterval": "monthly",
            "mustKeepFunded": true,
            "notes": "production",
        ],
        "createdAt": "2026-01-01T00:00:00.000Z",
    ]]

    private static let providerMutationJSON: [String: Any] = [
        "id": "provider-1",
        "name": "openai",
        "displayName": "OpenAI",
        "isActive": false,
    ]

    private static let subscriptionMutationJSON: [String: Any] = [
        "id": "subscription-1",
        "name": "OpenAI Plus",
        "status": "paused",
        "nextRenewalAt": "2026-08-01T00:00:00.000Z",
    ]
}

private final class ManagementURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> ManagementStubResponse)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw URLError(.badServerResponse)
            }
            let stub = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: stub.status,
                httpVersion: "HTTP/1.1",
                headerFields: stub.headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: stub.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private struct ManagementStubResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func json(
        _ object: Any,
        status: Int = 200,
        headers: [String: String] = [:]
    ) -> ManagementStubResponse {
        var responseHeaders = headers
        responseHeaders["Content-Type"] = "application/json"
        return ManagementStubResponse(
            status: status,
            headers: responseHeaders,
            body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }
}
