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

    func testSubscriptionsListDecodes() async throws {
        let harness = makeHarness(token: "read-token")
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/subscriptions")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer read-token")
            return .json(Self.subscriptionsJSON)
        }

        let subscriptions = try await harness.client.subscriptions()

        XCTAssertEqual(subscriptions.count, 1)
        XCTAssertEqual(subscriptions[0].id, "subscription-1")
        XCTAssertEqual(subscriptions[0].name, "OpenAI Plus")
        XCTAssertEqual(subscriptions[0].effectiveStatus, "active")
        XCTAssertEqual(subscriptions[0].provider.title, "OpenAI")
    }

    func testSessionCookieCanReadAndManageWithoutBearer() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            switch request.url?.path {
            case "/api/budget-status":
                return .json(Self.budgetJSON)
            case "/api/usage-events":
                // The session probe must be the lightweight bounded query, not
                // the heavy `?view=dashboard` inventory.
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query
                XCTAssertEqual(query, "raw=1&limit=1&days=1")
                return .json(Self.sessionProbeJSON)
            default:
                return .json(["error": "unexpected"], status: 404)
            }
        }

        _ = try await harness.client.budgetStatus()
        let capabilities = try await harness.client.accessCapabilities()

        XCTAssertEqual(capabilities.bearerRead, .notConfigured)
        XCTAssertEqual(capabilities.sessionManagement, .active(providerCount: nil))
        XCTAssertTrue(capabilities.canRead)
        XCTAssertTrue(capabilities.canManage)
    }

    func testSessionStatusCachesProbeBriefly() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        var probeCount = 0
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/usage-events")
            probeCount += 1
            return .json(Self.sessionProbeJSON)
        }

        let first = try await harness.client.sessionStatus()
        let second = try await harness.client.sessionStatus()

        XCTAssertEqual(first, .active(providerCount: nil))
        XCTAssertEqual(second, first)
        XCTAssertEqual(probeCount, 1, "Repeated Settings appears must reuse the cached probe.")
    }

    func testSessionProbeCacheInvalidatesOnLogout() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        var probeCount = 0
        ManagementURLProtocol.handler = { request in
            if request.url?.path == "/api/auth/logout" {
                return .json(["ok": true])
            }
            probeCount += 1
            return .json(Self.sessionProbeJSON)
        }

        _ = try await harness.client.sessionStatus()
        _ = try await harness.client.logout()
        let signedOut = try await harness.client.sessionStatus()

        XCTAssertEqual(signedOut, .signedOut)
        XCTAssertEqual(probeCount, 1, "No cookie means no probe at all after logout.")
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

            XCTAssertEqual(request.url?.path, "/api/usage-events")
            XCTAssertNil(request.httpBody)
            XCTAssertFalse(String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("correct horse") ?? false)
            return .json(Self.sessionProbeJSON)
        }

        _ = try await harness.client.login(password: "correct horse")
        let status = try await harness.client.sessionStatus()

        XCTAssertEqual(status, .active(providerCount: nil))
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

    func testSubscriptionResumeSendsActivationMode() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/subscriptions/subscription-1")
            XCTAssertEqual(request.httpMethod, "PUT")
            let body = Self.jsonObject(request)
            XCTAssertEqual(body["status"] as? String, "active")
            XCTAssertEqual(body["activationMode"] as? String, "resume")
            XCTAssertNil(body["autoRenew"], "autoRenew must be omitted unless the caller flips it.")
            return .json(Self.subscriptionMutationJSON)
        }

        let receipt = try await harness.client.activateSubscription(id: "subscription-1", mode: .resume)
        XCTAssertEqual(receipt.nextRenewalAt, "2026-08-01T00:00:00.000Z")
    }

    func testSubscriptionRepurchaseOfExpiredTermSendsAutoRenew() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            let body = Self.jsonObject(request)
            XCTAssertEqual(body["status"] as? String, "active")
            XCTAssertEqual(body["activationMode"] as? String, "repurchase")
            XCTAssertEqual(body["autoRenew"] as? Bool, true)
            return .json(Self.subscriptionMutationJSON)
        }

        _ = try await harness.client.activateSubscription(
            id: "subscription-1",
            mode: .repurchase,
            renewAutomatically: true
        )
    }

    func testPlanPatchEncodesEditableNullsAndPreservesUnmanagedFields() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        let provider = try JSONDecoder().decode(
            [ProviderManagementItem].self,
            from: Self.data(Self.providersJSON)
        )[0]
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/providers/provider-1")
            XCTAssertEqual(request.httpMethod, "PUT")
            let plan = (Self.jsonObject(request)["plan"] as? [String: Any]) ?? [:]
            // Edited fields land as values…
            XCTAssertEqual(plan["fixedMonthlyCostUsd"] as? Double, 25)
            XCTAssertEqual(plan["notes"] as? String, "primary org")
            XCTAssertEqual(plan["renewalDate"] as? String, "2026-08-15")
            XCTAssertEqual(plan["billingInterval"] as? String, "monthly")
            XCTAssertEqual(plan["monthlyBudgetUsd"] as? Double, 100)
            // …cleared fields are explicit JSON null, not omitted keys…
            XCTAssertTrue(plan.keys.contains("billingInterval"))
            // …and unmanaged fields round-trip from the inventory item.
            XCTAssertEqual(plan["billingMode"] as? String, "manual")
            XCTAssertEqual(plan["monthlyRequestLimit"] as? Int, 5000)
            XCTAssertEqual(plan["lowBalanceUsd"] as? Double, 10)
            XCTAssertEqual(plan["mustKeepFunded"] as? Bool, true)
            return .json(Self.providerMutationJSON)
        }

        _ = try await harness.client.updateProviderPlan(
            provider: provider,
            patch: ProviderPlanPatch(
                monthlyBudgetUsd: 100,
                fixedMonthlyCostUsd: 25,
                notes: "primary org",
                renewalDate: "2026-08-15",
                billingInterval: "monthly"
            )
        )
    }

    func testPlanPatchSendsExplicitNullForClearedEditableFields() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        let provider = try JSONDecoder().decode(
            [ProviderManagementItem].self,
            from: Self.data(Self.providersJSON)
        )[0]
        ManagementURLProtocol.handler = { request in
            let plan = (Self.jsonObject(request)["plan"] as? [String: Any]) ?? [:]
            for key in ["fixedMonthlyCostUsd", "renewalDate", "billingInterval", "notes", "monthlyBudgetUsd"] {
                XCTAssertTrue(plan.keys.contains(key), "\(key) must be sent")
                XCTAssertTrue(plan[key] is NSNull, "\(key) clear must be JSON null, not an omitted key")
            }
            return .json(Self.providerMutationJSON)
        }

        _ = try await harness.client.updateProviderPlan(
            provider: provider,
            patch: ProviderPlanPatch()
        )
    }

    func testFetchProviderNowPostsToFetchRoute() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/providers/provider-1/fetch")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(Self.fetchReceiptJSON, status: 201)
        }

        let receipt = try await harness.client.fetchProviderNow(id: "provider-1")
        XCTAssertEqual(receipt.providerId, "provider-1")
        XCTAssertEqual(receipt.totalCost, 182.4)
        XCTAssertNotNil(receipt.fetchedDate)
    }

    func testProjectCreatePostsSessionOnlyBoundedPayload() async throws {
        let harness = makeHarness(token: "read-token")
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/projects")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(
                request.value(forHTTPHeaderField: "Authorization"),
                "Project mutations are session-only; the bearer must not be attached."
            )
            let body = Self.jsonObject(request)
            XCTAssertEqual(body["name"] as? String, "Socratic Trade")
            XCTAssertEqual(body["description"] as? String, "Trading loop")
            XCTAssertEqual(body["monthlyBudgetUsd"] as? Double, 400)
            return .json(Self.projectMutationJSON)
        }

        let receipt = try await harness.client.createProject(
            name: "Socratic Trade",
            description: "Trading loop",
            monthlyBudgetUsd: 400
        )
        XCTAssertEqual(receipt.id, "project-1")
        XCTAssertEqual(receipt.backfilledEvents, 3)
    }

    func testProjectUpdateSendsExplicitNullToClearBudget() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/projects/project-1")
            XCTAssertEqual(request.httpMethod, "PUT")
            let body = Self.jsonObject(request)
            XCTAssertEqual(body["name"] as? String, "Renamed")
            // Blank description is SENT (the server trims it to null); a cleared
            // budget is an explicit JSON null, never an omitted key.
            XCTAssertEqual(body["description"] as? String, "")
            XCTAssertTrue(body.keys.contains("monthlyBudgetUsd"))
            XCTAssertTrue(body["monthlyBudgetUsd"] is NSNull)
            return .json(Self.projectMutationJSON)
        }

        _ = try await harness.client.updateProject(
            id: "project-1",
            name: "Renamed",
            description: "",
            monthlyBudgetUsd: nil
        )
    }

    func testProjectDeleteIssuesSessionOnlyDelete() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/projects/project-1")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(["success": true])
        }

        let receipt = try await harness.client.deleteProject(id: "project-1")
        XCTAssertTrue(receipt.success)
    }

    func testProviderDeleteIssuesSessionOnlyDelete() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/providers/provider-1")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(["success": true])
        }

        let receipt = try await harness.client.deleteProvider(id: "provider-1")
        XCTAssertTrue(receipt.success)
    }

    func testSubscriptionDeleteIssuesSessionOnlyDelete() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/subscriptions/subscription-1")
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(["ok": true])
        }

        let receipt = try await harness.client.deleteSubscription(id: "subscription-1")
        XCTAssertTrue(receipt.ok)
    }

    func testProviderCanDeleteHidesManagedCredentials() {
        let free = ProviderManagementItem(
            id: "p1",
            name: "openrouter",
            displayName: "OpenRouter",
            type: "openrouter",
            isActive: true,
            refreshIntervalMin: 15,
            createdAt: "2026-08-01T00:00:00.000Z"
        )
        XCTAssertTrue(free.canDelete)

        let managed = ProviderManagementItem(
            id: "p2",
            name: "anthropic",
            displayName: "Anthropic",
            type: "anthropic",
            isActive: true,
            refreshIntervalMin: 15,
            credentialManagement: .init(
                source: "infisical",
                scope: "st",
                label: "Primary",
                status: "ok",
                alias: false,
                readOnlyFields: ["isActive"]
            ),
            createdAt: "2026-08-01T00:00:00.000Z"
        )
        XCTAssertFalse(managed.canDelete)
    }

    func testUsageSnapshotsSendsBoundedQuerySessionOnly() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/snapshots")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query
            XCTAssertEqual(query, "providerId=provider-1&days=30")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(Self.snapshotsJSON)
        }

        let snapshots = try await harness.client.usageSnapshots(providerID: "provider-1")

        XCTAssertEqual(snapshots.count, 2)
        XCTAssertEqual(snapshots[0].totalCost, 120.5)
        XCTAssertFalse(snapshots[0].isRollup)
        XCTAssertTrue(snapshots[1].isRollup)
        XCTAssertEqual(snapshots[1].sampleCount, 4)
        XCTAssertNotNil(snapshots[0].fetchedDate)
    }

    func testUsageSnapshotsHonorsExplicitDayWindow() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query
            XCTAssertEqual(query, "providerId=provider-1&days=365")
            return .json(Self.snapshotsJSON)
        }

        _ = try await harness.client.usageSnapshots(
            providerID: "provider-1",
            days: SnapshotHistoryRange.oneYear.days
        )
    }

    func testAgentsOverviewSendsWindowAsQueryItem() async throws {
        let harness = makeHarness(token: "read-token")
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/agents-overview")
            XCTAssertFalse(
                (request.url?.absoluteString ?? "").contains("%3F"),
                "window must be a query item; appendingPathComponent encodes an inlined ?"
            )
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query
            XCTAssertEqual(query, "window=5h")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer read-token")
            return .json(Self.agentsOverviewJSON)
        }

        let response = try await harness.client.agentsOverview(window: "5h")

        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.windowDays, 0.2083, accuracy: 0.0001)
        XCTAssertEqual(response.summary.totalAgentCount, 1)
    }

    func testProviderDetailDecodesExternalBilling() async throws {
        let harness = makeHarness()
        installSessionCookie(in: harness)
        ManagementURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/providers/provider-1")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(Self.providerDetailJSON)
        }

        let detail = try await harness.client.providerDetail(id: "provider-1")

        XCTAssertEqual(detail.id, "provider-1")
        let records = try XCTUnwrap(detail.externalBilling)
        XCTAssertEqual(records.count, 1)
        let record = records[0]
        XCTAssertEqual(record.source, "stripe")
        XCTAssertEqual(record.displayName, "Workers Paid")
        XCTAssertEqual(record.amountUsd, 5)
        XCTAssertEqual(record.status, "active")
        XCTAssertNotNil(record.currentPeriodStartDate)
        XCTAssertNotNil(record.syncedDate)
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

    private static let sessionProbeJSON: [String: Any] = [
        "mode": "raw",
        "days": 1,
        "limit": 1,
        "order": "desc",
        "nextCursor": NSNull(),
        "hasMore": false,
        "events": [],
    ]

    private static let fetchReceiptJSON: [String: Any] = [
        "id": "snapshot-1",
        "providerId": "provider-1",
        "fetchedAt": "2026-07-29T12:00:00.000Z",
        "balance": NSNull(),
        "totalCost": 182.4,
        "totalRequests": 910,
        "credits": NSNull(),
        "createdAt": "2026-07-29T12:00:00.000Z",
    ]

    private static let projectMutationJSON: [String: Any] = [
        "id": "project-1",
        "name": "Socratic Trade",
        "nameKey": "socratic trade",
        "description": "Trading loop",
        "monthlyBudgetUsd": 400,
        "backfilledEvents": 3,
    ]

    private static let snapshotsJSON: [[String: Any]] = [
        [
            "id": "snapshot-1",
            "providerId": "provider-1",
            "fetchedAt": "2026-07-28T12:00:00.000Z",
            "balance": NSNull(),
            "totalCost": 120.5,
            "totalRequests": 610,
            "credits": NSNull(),
            "createdAt": "2026-07-28T12:00:00.000Z",
        ],
        [
            "id": "rollup:rollup-1",
            "providerId": "provider-1",
            "fetchedAt": "2026-07-01T23:59:00.000Z",
            "balance": NSNull(),
            "totalCost": 40.25,
            "totalRequests": 200,
            "credits": NSNull(),
            "createdAt": "2026-07-02T00:10:00.000Z",
            "rollup": true,
            "sampleCount": 4,
        ],
    ]

    private static let providerDetailJSON: [String: Any] = [
        "id": "provider-1",
        "name": "openai",
        "displayName": "OpenAI",
        "type": "openai",
        "isActive": true,
        "refreshIntervalMin": 15,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "externalBilling": [[
            "source": "stripe",
            "externalId": "sub_123",
            "kind": "subscription",
            "serviceName": "Workers Paid",
            "planName": NSNull(),
            "status": "active",
            "amountUsd": 5,
            "currency": "USD",
            "billingInterval": "monthly",
            "currentPeriodStart": "2026-07-17T00:00:00.000Z",
            "currentPeriodEnd": "2026-08-17T00:00:00.000Z",
            "nextRenewalAt": "2026-08-17T00:00:00.000Z",
            "syncedAt": "2026-07-29T08:00:00.000Z",
        ]],
    ]

    private static let agentsOverviewJSON: [String: Any] = [
        "ok": true,
        "windowDays": 0.2083,
        "windowLabel": "Last 24 Hours",
        "generatedAt": "2026-09-18T08:00:00.000Z",
        "macHostname": "jays.services",
        "macChip": "Apple M5",
        "summary": [
            "activeAgentCount": 0,
            "totalAgentCount": 1,
            "totalTokens": 0,
            "totalApiEquivalentCostUsd": 0,
            "totalSubscriptionCostUsd": 0,
            "totalNetSavingsUsd": 0,
            "savingsMultiplier": 1,
            "topModel": NSNull(),
        ],
        "burn5h": [
            "tokens5h": 0,
            "costEstimate5hUsd": 0,
            "burnRateTokensPerHour": 0,
            "burnRateUsdPerHour": 0,
        ],
        "platforms": [],
        "modelDistribution": [],
    ]

    private static let subscriptionsJSON: [[String: Any]] = [[
        "id": "subscription-1",
        "name": "OpenAI Plus",
        "costUsd": 20,
        "currency": "USD",
        "interval": "month",
        "intervalCount": 1,
        "monthlyEquivalentUsd": 20,
        "startDate": "2026-01-01T00:00:00.000Z",
        "currentPeriodStart": "2026-07-01T00:00:00.000Z",
        "nextRenewalAt": "2026-08-01T00:00:00.000Z",
        "autoRenew": true,
        "status": "active",
        "effectiveStatus": "active",
        "provider": [
            "id": "provider-1",
            "name": "openai",
            "displayName": "OpenAI",
        ],
    ]]
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
            let stub = try handler(Self.materializingBody(of: request))
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

    /// `URLSession` converts a request's `httpBody` into an `httpBodyStream`
    /// before handing it to a custom `URLProtocol`, so `httpBody` reads back as
    /// nil inside the stub and every payload assertion silently passes over an
    /// empty dictionary. Drain the stream once here and give the handler a
    /// request whose `httpBody` is populated, so body assertions are real and
    /// can be made repeatedly without re-reading a consumed stream.
    private static func materializingBody(of request: URLRequest) -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else {
            return request
        }

        var body = Data()
        let bufferSize = 4_096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        stream.open()
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            body.append(buffer, count: read)
        }
        stream.close()

        guard !body.isEmpty else { return request }
        var materialized = request
        materialized.httpBodyStream = nil
        materialized.httpBody = body
        return materialized
    }
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
