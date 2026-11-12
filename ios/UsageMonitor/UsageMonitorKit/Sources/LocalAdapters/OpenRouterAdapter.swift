import Foundation
import LocalSecrets

/// OpenRouter poll adapter — mirrors `src/lib/adapters/openrouter.ts` key-tier policy (K21).
public struct OpenRouterAdapter: ProviderAdapter, Sendable {
    public let adapterKind = "openrouter"
    public var session: URLSession
    public var timeout: TimeInterval

    public init(session: URLSession = .shared, timeout: TimeInterval = 30) {
        self.session = session
        self.timeout = timeout
    }

    public func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult {
        let key = credentials.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw AdapterRunError.configuration("OpenRouter API key is empty") }

        let keyJSON = try await getJSON(url: "https://openrouter.ai/api/v1/key", apiKey: key)
        guard let data = keyJSON["data"] as? [String: Any] else {
            throw AdapterRunError.invalidResponse("OpenRouter /key missing data")
        }

        let isManagement =
            (data["is_management_key"] as? Bool == true)
            || (data["is_provisioning_key"] as? Bool == true)

        if !isManagement {
            return LocalUsageResult(
                totalCost: nil,
                balance: nil,
                costScope: .unknown,
                fetchedAt: Date(),
                statusNote:
                    "Connected with an inference key. Month-to-date budget needs an OpenRouter Management (Provisioning) key."
            )
        }

        // Management path: /credits + /activity (skip full /keys enumeration for v1 speed)
        async let creditsTask = getJSONOptional(url: "https://openrouter.ai/api/v1/credits", apiKey: key)
        async let activityTask = getJSONOptional(url: "https://openrouter.ai/api/v1/activity", apiKey: key)
        let (creditsJSON, activityJSON) = try await (creditsTask, activityTask)

        var balance: Double?
        var credits: Double?
        if let cdata = creditsJSON?["data"] as? [String: Any] {
            let totalCredits = Self.num(cdata["total_credits"])
            let totalUsage = Self.num(cdata["total_usage"])
            if let totalCredits, let totalUsage {
                credits = totalCredits
                balance = totalCredits - totalUsage
            }
        }

        let now = Date()
        let monthStart = utcMonthStart(now)
        let monthStartStr = dayString(monthStart)

        var totalCost: Double?
        var totalRequests: Int?
        if let activityJSON,
           let rows = activityJSON["data"] as? [[String: Any]] {
            var monthToDateUsd = 0.0
            var windowRequests = 0
            for row in rows {
                if let r = Self.num(row["requests"]) { windowRequests += Int(r) }
                if let date = row["date"] as? String, date >= monthStartStr,
                   let usage = Self.num(row["usage"]) {
                    monthToDateUsd += usage
                }
            }
            totalRequests = windowRequests
            // Day 31 of 31-day months: withhold MTD (server parity)
            let day = Calendar(identifier: .gregorian).component(.day, from: now)
            // Use UTC day
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TimeZone(secondsFromGMT: 0)!
            let utcDay = cal.component(.day, from: now)
            totalCost = utcDay <= 30 ? monthToDateUsd : nil
            _ = day
        }

        let caveat: LocalCostCoverageCaveat? =
            totalCost != nil
            ? LocalCostCoverageCaveat(
                code: "openrouter_activity_mtd_estimate",
                message:
                    "Month-to-date cost is estimated from OpenRouter /activity rows since the UTC month start, not an invoice."
            )
            : nil

        return LocalUsageResult(
            totalCost: totalCost,
            balance: balance,
            fixedCostIncludedUsd: nil,
            costWindowStart: totalCost != nil ? monthStart : nil,
            costWindowEnd: totalCost != nil ? now : nil,
            costScope: totalCost != nil ? .calendarMonthToDate : .unknown,
            costIncludesUnknownFixed: false,
            totalRequests: totalRequests,
            credits: credits,
            costCoverageCaveat: caveat,
            fetchedAt: now,
            statusNote: totalCost == nil
                ? "Management key connected; MTD cost unavailable (day-31 withhold or activity empty)."
                : nil
        )
    }

    // MARK: - HTTP

    private func getJSON(url: String, apiKey: String) async throws -> [String: Any] {
        guard let parsed = try await getJSONOptional(url: url, apiKey: apiKey) else {
            throw AdapterRunError.invalidResponse("Empty response from \(url)")
        }
        return parsed
    }

    private func getJSONOptional(url: String, apiKey: String) async throws -> [String: Any]? {
        guard let u = URL(string: url) else { throw AdapterRunError.configuration("Bad URL") }
        var req = URLRequest(url: u, timeoutInterval: timeout)
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError where e.code == .timedOut {
            throw AdapterRunError.timeout
        } catch {
            throw AdapterRunError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw AdapterRunError.transport("Non-HTTP response")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            let body = String(data: data, encoding: .utf8)
            throw AdapterRunError.httpStatus(http.statusCode, body)
        }
        if !(200...299).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8)
            throw AdapterRunError.httpStatus(http.statusCode, body)
        }
        let obj = try JSONSerialization.jsonObject(with: data)
        return obj as? [String: Any]
    }

    private static func num(_ any: Any?) -> Double? {
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        if let n = any as? NSNumber { return n.doubleValue }
        if let s = any as? String { return Double(s) }
        return nil
    }

    private func utcMonthStart(_ date: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month], from: date)
        return cal.date(from: DateComponents(year: c.year, month: c.month, day: 1))!
    }

    private func dayString(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}
