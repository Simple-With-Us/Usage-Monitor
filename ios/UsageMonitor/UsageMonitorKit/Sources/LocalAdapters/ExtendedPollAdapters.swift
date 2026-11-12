import Foundation
import LocalSecrets

// Additional Local poll adapters — HTTPS + key (and optional SID/teamId).

// MARK: - Apify (MTD USD bill)

public struct ApifyAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "apify"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Apify token empty") }
        let headers = ["Authorization": "Bearer \(key)"]
        async let limitsTask = LocalHTTP.getJSON(
            url: "https://api.apify.com/v2/users/me/limits",
            headers: headers
        )
        async let userTask = LocalHTTP.getJSON(
            url: "https://api.apify.com/v2/users/me",
            headers: headers
        )
        let (_, limitsJson) = try await limitsTask
        let userPair = try? await userTask

        let data = limitsJson?["data"] as? [String: Any]
        let current = data?["current"] as? [String: Any]
        let usedMonthly = LocalHTTP.num(current?["monthlyUsageUsd"])
        let plan = (userPair?.json?["data"] as? [String: Any])?["plan"] as? [String: Any]
        let monthlyBase = LocalHTTP.num(plan?["monthlyBasePriceUsd"])
        let included = LocalHTTP.num(plan?["monthlyUsageCreditsUsd"])
        let balance: Double? = {
            guard let included, let usedMonthly else { return nil }
            return max(0, included - usedMonthly)
        }()
        let currentBill: Double? = {
            if let monthlyBase, let usedMonthly, let included {
                return monthlyBase + max(0, usedMonthly - included)
            }
            if monthlyBase != nil || usedMonthly != nil {
                return max(monthlyBase ?? 0, usedMonthly ?? 0)
            }
            return nil
        }()
        let cycle = data?["monthlyUsageCycle"] as? [String: Any]
        let cycleStartStr = cycle?["startAt"] as? String
        let cycleEndStr = cycle?["endAt"] as? String
        let cycleStart = cycleStartStr.flatMap { ISO8601DateFormatter().date(from: $0) }
            ?? cycleStartStr.flatMap { ISO8601DateFormatter.withFractional.date(from: $0) }
        let now = Date()
        let monthStart = LocalHTTP.utcMonthStart(now)
        let nextMonth = Calendar(identifier: .gregorian).date(byAdding: .month, value: 1, to: monthStart)!
        let isCurrentMonthCycle =
            cycleStart.map { $0 >= monthStart && $0 < nextMonth } ?? false
        let bill = isCurrentMonthCycle ? currentBill : nil

        return LocalUsageResult(
            totalCost: bill,
            balance: balance,
            fixedCostIncludedUsd: bill != nil ? monthlyBase : nil,
            costWindowStart: bill != nil ? cycleStart : nil,
            costWindowEnd: cycleEndStr.flatMap { ISO8601DateFormatter().date(from: $0) },
            costScope: bill != nil ? .billingCycleToDate : .unknown,
            credits: balance,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "apify_usage_cycle",
                message: bill != nil
                    ? "Apify plan base + overage for the current usage cycle (USD)."
                    : "Apify cycle is outside this UTC month — cost withheld."
            ),
            fetchedAt: now
        )
    }
}

// MARK: - Firecrawl (credits)

public struct FirecrawlAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "firecrawl"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Firecrawl key empty") }
        let (_, json) = try await LocalHTTP.getJSON(
            url: "https://api.firecrawl.dev/v2/team/credit-usage",
            headers: ["Authorization": "Bearer \(key)"]
        )
        let data = json?["data"] as? [String: Any] ?? json
        let remaining = LocalHTTP.num(data?["remainingCredits"])
        let planCredits = LocalHTTP.num(data?["planCredits"])
        return LocalUsageResult(
            totalCost: nil,
            balance: remaining,
            costScope: .unknown,
            credits: remaining,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "firecrawl_credits",
                message: "Firecrawl exposes remaining credits only — no USD total. Track plan fee as a subscription if needed."
                    + (planCredits.map { " Plan includes \(Int($0)) credits." } ?? "")
            ),
            statusNote: remaining.map { String(format: "%.0f credits remaining", $0) }
        )
    }
}

// MARK: - Twelve Data (quota)

public struct TwelveDataAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "twelvedata"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Twelve Data key empty") }
        let (_, json) = try await LocalHTTP.getJSON(
            url: "https://api.twelvedata.com/api_usage",
            headers: ["Authorization": "apikey \(key)"]
        )
        let current = LocalHTTP.num(json?["current_usage"])
        let limit = LocalHTTP.num(json?["plan_limit"])
        let daily = LocalHTTP.num(json?["daily_usage"])
        let dailyLimit = LocalHTTP.num(json?["plan_daily_limit"])
        let remaining: Double? = {
            if let limit, let current { return max(0, limit - current) }
            if let dailyLimit, let daily { return max(0, dailyLimit - daily) }
            return nil
        }()
        return LocalUsageResult(
            totalCost: nil,
            balance: remaining,
            costScope: .unknown,
            totalRequests: current.map { Int($0) },
            credits: remaining,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "twelvedata_quota",
                message: "Twelve Data API quota only — no dollar billing. Set a subscription fee for plan cost."
            ),
            statusNote: remaining.map { String(format: "%.0f credits remaining", $0) }
        )
    }
}

// MARK: - Pushover (message quota)

public struct PushoverAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "pushover"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let token = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw AdapterRunError.configuration("Pushover app token empty") }
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        let (_, json) = try await LocalHTTP.getJSON(
            url: "https://api.pushover.net/1/apps/limits.json?token=\(encoded)",
            headers: [:]
        )
        let limit = LocalHTTP.num(json?["limit"])
        let remaining = LocalHTTP.num(json?["remaining"])
        let used: Double? = {
            guard let limit, let remaining else { return nil }
            return max(0, limit - remaining)
        }()
        return LocalUsageResult(
            totalCost: nil,
            balance: remaining,
            costScope: .unknown,
            totalRequests: used.map { Int($0) },
            credits: remaining,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "pushover_message_quota",
                message: "Pushover monthly message remaining — not USD. License fees stay as subscriptions."
            ),
            statusNote: remaining.map { String(format: "%.0f messages remaining", $0) }
        )
    }
}

// MARK: - Resend (email usage headers)

public struct ResendAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "resend"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("Resend key empty") }
        guard let url = URL(string: "https://api.resend.com/api-keys") else {
            throw AdapterRunError.configuration("Bad Resend URL")
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (_, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw AdapterRunError.transport("Non-HTTP response")
        }
        if !(200...299).contains(http.statusCode) {
            throw AdapterRunError.httpStatus(http.statusCode, nil)
        }
        func header(_ name: String) -> Double? {
            let key = http.allHeaderFields.keys
                .compactMap { $0 as? String }
                .first { $0.caseInsensitiveCompare(name) == .orderedSame }
            guard let key, let raw = http.value(forHTTPHeaderField: key) else { return nil }
            return Double(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let monthly = header("x-resend-monthly-quota")
        let daily = header("x-resend-daily-quota")
        return LocalUsageResult(
            totalCost: nil,
            costScope: .unknown,
            totalRequests: monthly.map { Int($0) } ?? daily.map { Int($0) },
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "resend_usage_headers",
                message: "Resend returns emails-used headers only — no plan remaining or USD. Track plan as a subscription."
            ),
            statusNote: monthly.map { String(format: "%.0f emails used this month", $0) }
        )
    }
}

// MARK: - Stripe (MTD processing fees)

public struct StripeAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "stripe"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let sk = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sk.isEmpty else { throw AdapterRunError.configuration("Stripe secret key empty") }
        let basic = Data("\(sk):".utf8).base64EncodedString()
        let headers = ["Authorization": "Basic \(basic)"]
        let monthStart = LocalHTTP.utcMonthStart()
        let gte = Int(monthStart.timeIntervalSince1970)

        // Balance
        let (_, balJson) = try await LocalHTTP.getJSON(
            url: "https://api.stripe.com/v1/balance",
            headers: headers
        )
        var availableUsd = 0.0
        if let available = balJson?["available"] as? [[String: Any]] {
            for row in available where (row["currency"] as? String)?.lowercased() == "usd" {
                availableUsd += (LocalHTTP.num(row["amount"]) ?? 0) / 100
            }
        }

        // Fee sum (capped pages)
        var feeCents = 0.0
        var startingAfter: String?
        for _ in 0..<20 {
            var url = "https://api.stripe.com/v1/balance_transactions?created[gte]=\(gte)&limit=100"
            if let startingAfter {
                url += "&starting_after=\(startingAfter)"
            }
            let (_, page) = try await LocalHTTP.getJSON(url: url, headers: headers)
            let data = page?["data"] as? [[String: Any]] ?? []
            for row in data {
                feeCents += LocalHTTP.num(row["fee"]) ?? 0
            }
            guard page?["has_more"] as? Bool == true, let last = data.last?["id"] as? String else {
                break
            }
            startingAfter = last
        }
        let feeUsd = feeCents / 100
        return LocalUsageResult(
            totalCost: feeUsd,
            balance: availableUsd,
            fixedCostIncludedUsd: 0,
            costWindowStart: monthStart,
            costWindowEnd: Date(),
            costScope: .calendarMonthToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "stripe_processing_fees",
                message: "Stripe MTD is processing *fees* (ops cost), not customer charge volume or subscription bill."
            ),
            fetchedAt: Date()
        )
    }
}

// MARK: - xAI (management billing)

public struct XAIAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "xai"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let teamId = credentials.teamId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !key.isEmpty else { throw AdapterRunError.configuration("xAI management key empty") }
        guard !teamId.isEmpty else {
            throw AdapterRunError.configuration("xAI requires teamId (store with credentials)")
        }
        let headers = ["Authorization": "Bearer \(key)"]
        let base = "https://management-api.x.ai/v1/billing/teams/\(teamId)"
        async let balTask = LocalHTTP.getJSON(url: "\(base)/prepaid/balance", headers: headers)
        async let invTask = LocalHTTP.getJSON(url: "\(base)/postpaid/invoice/preview", headers: headers)
        let balPair = try? await balTask
        let invPair = try? await invTask

        func cents(_ obj: [String: Any]?, _ path: [String]) -> Double? {
            var cur: Any? = obj
            for p in path {
                cur = (cur as? [String: Any])?[p]
            }
            if let s = cur as? String, let v = Double(s) { return abs(v) / 100 }
            if let n = LocalHTTP.num(cur) { return abs(n) / 100 }
            return nil
        }

        let balance = cents(balPair?.json, ["total", "val"])
            ?? cents(balPair?.json, ["total"])
        let cost = cents(invPair?.json, ["coreInvoice", "totalWithCorr", "val"])
            ?? cents(invPair?.json, ["totalWithCorr", "val"])
            ?? cents(invPair?.json, ["total", "val"])

        return LocalUsageResult(
            totalCost: cost,
            balance: balance,
            costWindowStart: LocalHTTP.utcMonthStart(),
            costWindowEnd: Date(),
            costScope: .billingCycleToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "xai_management_billing",
                message: "xAI Management API invoice preview / prepaid balance (cents→USD). Not the inference key."
            ),
            fetchedAt: Date()
        )
    }
}

// MARK: - Twilio (balance + ThisMonth totalprice)

public struct TwilioAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "twilio"
    public init() {}

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let sid = credentials.accountSid?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let secret = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sid.isEmpty else {
            throw AdapterRunError.configuration("Twilio requires accountSid + auth token/secret")
        }
        guard !secret.isEmpty else { throw AdapterRunError.configuration("Twilio secret empty") }
        let user: String
        let pass: String
        if let keySid = credentials.apiKeySid?.trimmingCharacters(in: .whitespacesAndNewlines), !keySid.isEmpty {
            user = keySid
            pass = secret
        } else {
            user = sid
            pass = secret
        }
        let basic = Data("\(user):\(pass)".utf8).base64EncodedString()
        let headers = ["Authorization": "Basic \(basic)"]
        let root = "https://api.twilio.com/2010-04-01/Accounts/\(sid)"

        async let balTask = LocalHTTP.getJSON(url: "\(root)/Balance.json", headers: headers)
        async let usageTask = LocalHTTP.getJSON(
            url: "\(root)/Usage/Records/ThisMonth.json?Category=totalprice",
            headers: headers
        )
        let balJson = try? await balTask
        let usageJson = try? await usageTask

        let balance = LocalHTTP.num(balJson?.json?["balance"])
        var cost: Double?
        if let records = usageJson?.json?["usage_records"] as? [[String: Any]] {
            for row in records {
                if let price = LocalHTTP.num(row["price"]) {
                    cost = abs(price)
                    break
                }
            }
        }
        return LocalUsageResult(
            totalCost: cost,
            balance: balance,
            costWindowStart: LocalHTTP.utcMonthStart(),
            costWindowEnd: Date(),
            costScope: .calendarMonthToDate,
            costCoverageCaveat: LocalCostCoverageCaveat(
                code: "twilio_this_month_totalprice",
                message: "Twilio ThisMonth totalprice + balance. Store Account SID with the auth token."
            ),
            fetchedAt: Date()
        )
    }
}

private extension ISO8601DateFormatter {
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
