import Foundation

/// Read-only quota probes for vendor CLI credentials that are already present on this Mac.
/// Credential and response contents never appear in `LocalQuotaResult` errors.
public struct AdditionalQuotaReader: Sendable {
    private let homeDirectory: URL
    private let now: @Sendable () -> Date
    private let fetchJSON: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    private static let maxBytes = 1_048_576

    public init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        now: @escaping @Sendable () -> Date = { Date() },
        fetchJSON: (@Sendable (URLRequest) async throws -> (Data, HTTPURLResponse))? = nil
    ) {
        self.homeDirectory = homeDirectory.standardizedFileURL
        self.now = now
        self.fetchJSON = fetchJSON ?? Self.makeFetcher()
    }

    public func read() async -> LocalQuotaResult {
        await withTaskGroup(of: ProviderResult.self, returning: LocalQuotaResult.self) { group in
            group.addTask { await readGemini() }
            group.addTask { await readKimi() }
            var windows: [QuotaWindow] = []
            var issues: [String: String] = [:]
            for await result in group {
                windows.append(contentsOf: result.windows)
                if let issue = result.issue { issues[result.key] = issue }
            }
            windows.sort { ($0.providerKey ?? $0.provider, $0.id) < ($1.providerKey ?? $1.provider, $1.id) }
            return LocalQuotaResult(windows: windows, issues: issues)
        }
    }

    private func readGemini() async -> ProviderResult {
        let key = "gemini-cli"
        do {
            guard let root = try readJSONObject(relativePath: ".gemini/oauth_creds.json") else {
                return ProviderResult(key: key, issue: "Gemini CLI is not signed in locally.")
            }
            guard let token = root["access_token"] as? String, validToken(token) else {
                return ProviderResult(key: key, issue: "Gemini CLI is not signed in locally.")
            }
            if let expiry = root["expiry_date"] as? NSNumber,
               Date(timeIntervalSince1970: expiry.doubleValue / (expiry.doubleValue > 10_000_000_000 ? 1000 : 1)) <= now() {
                return ProviderResult(key: key, issue: "Gemini CLI needs you to sign in again.")
            }
            let payload = try await fetchGeminiQuota(token: token)
            let buckets = (payload["buckets"] as? [[String: Any]]) ?? []
            let observed = now()
            let windows = buckets.enumerated().map { index, bucket in
                let model = bucket["modelId"] as? String
                let fraction = number(bucket["remainingFraction"])
                let validFraction = fraction.flatMap { $0.isFinite && $0 >= 0 && $0 <= 1 ? $0 : nil }
                return QuotaWindow(
                    id: "local-mac:gemini-cli:\(model ?? "bucket-\(index + 1)")", provider: "gemini-cli", providerKey: key,
                    providerLabel: "Gemini CLI", via: "gemini-cli", sourceApp: "local-mac",
                    modelId: model, label: model ?? "Quota bucket", remainingPercent: validFraction.map { $0 * 100 },
                    remainingUnknown: validFraction == nil, resetAt: bucket["resetTime"] as? String,
                    window: nil, occurredAt: iso8601(observed), source: "Gemini CLI OAuth quota")
            }
            guard !windows.isEmpty else { return ProviderResult(key: key, windows: [unknown(key: key, provider: "gemini-cli", label: "Gemini CLI quota", observed: observed)], issue: "Gemini CLI returned no readable quota buckets.") }
            return ProviderResult(key: key, windows: windows)
        } catch { return ProviderResult(key: key, issue: errorMessage(error, provider: "Gemini CLI")) }
    }

    private func readKimi() async -> ProviderResult {
        let key = "kimi"
        do {
            guard let root = try readJSONObject(relativePath: ".kimi-code/credentials/kimi-code.json") else {
                return ProviderResult(key: key, issue: "Kimi Code is not signed in locally.")
            }
            guard let token = root["access_token"] as? String, validToken(token) else {
                return ProviderResult(key: key, issue: "Kimi Code is not signed in locally.")
            }
            if let expiry = expiryDate(root), expiry <= now() {
                return ProviderResult(key: key, issue: "Kimi Code needs you to sign in again.")
            }
            var request = URLRequest(url: URL(string: "https://api.kimi.com/coding/v1/usages")!)
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            let payload = try await requestJSON(request)
            let observed = now()
            var windows: [QuotaWindow] = []
            if let usage = payload["usage"] as? [String: Any] {
                windows.append(kimiWindow(usage, id: "plan", label: "Plan quota", window: nil, observed: observed))
            }
            if let limits = payload["limits"] as? [[String: Any]] {
                for (index, limit) in limits.enumerated() {
                    guard let detail = limit["detail"] as? [String: Any], let window = limit["window"] as? [String: Any],
                          let duration = number(window["duration"]), duration.isFinite, duration > 0, duration <= 31_536_000, let unit = window["timeUnit"] as? String else { continue }
                    let token = "\(Int(duration))\(unit == "TIME_UNIT_MINUTE" ? "m" : " window")"
                    windows.append(kimiWindow(detail, id: "limit-\(index + 1)", label: "Kimi Code (\(token))", window: token, observed: observed))
                }
            }
            guard !windows.isEmpty else { return ProviderResult(key: key, windows: [unknown(key: key, provider: "kimi", label: "Kimi Code quota", observed: observed)], issue: "Kimi Code returned no readable quota windows.") }
            return ProviderResult(key: key, windows: windows)
        } catch { return ProviderResult(key: key, issue: errorMessage(error, provider: "Kimi Code")) }
    }

    private func kimiWindow(_ detail: [String: Any], id: String, label: String, window: String?, observed: Date) -> QuotaWindow {
        let limit = number(detail["limit"]); let remaining = number(detail["remaining"])
        let percent = limit.flatMap { limit in remaining.flatMap { limit > 0 ? $0 / limit * 100 : nil } }
        let effectiveRemaining = remaining ?? limit.flatMap { used in number(detail["used"]).map { max(0, used - $0) } }
        let effectivePercent = limit.flatMap { cap in cap > 0 ? effectiveRemaining.map { $0 / cap * 100 } : nil }
        return QuotaWindow(id: "local-mac:kimi:\(id)", provider: "kimi", providerKey: "kimi", providerLabel: "Kimi Code", via: "kimi-code", sourceApp: "local-mac", label: label, remainingPercent: percent ?? effectivePercent, absoluteRemaining: effectiveRemaining, absoluteLimit: limit, quotaUnit: "requests", remainingUnknown: (percent ?? effectivePercent) == nil, resetAt: detail["resetTime"] as? String, window: window, occurredAt: iso8601(observed), source: "Kimi Code usage API")
    }

    private func fetchGeminiQuota(token: String) async throws -> [String: Any] {
        do { return try await geminiRequest(token: token, path: "v1internal:retrieveUserQuota", body: [:]) }
        catch ReaderError.http(400) {
            let discovery = try await geminiRequest(token: token, path: "v1internal:loadCodeAssist", body: ["metadata": ["ideType": "GEMINI_CLI", "pluginType": "GEMINI"]])
            guard let project = discovery["cloudaicompanionProject"] as? String, !project.isEmpty else { throw ReaderError.malformed }
            return try await geminiRequest(token: token, path: "v1internal:retrieveUserQuota", body: ["project": project])
        }
    }

    private func geminiRequest(token: String, path: String, body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "https://cloudcode-pa.googleapis.com/\(path)")!)
        request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("application/json", forHTTPHeaderField: "Accept"); request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await requestJSON(request)
    }

    private func readJSONObject(relativePath: String) throws -> [String: Any]? {
        let url = homeDirectory.appendingPathComponent(relativePath)
        guard FileManager.default.isReadableFile(atPath: url.path) else { return nil }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let data = try handle.read(upToCount: Self.maxBytes + 1) ?? Data()
        guard data.count <= Self.maxBytes else { throw ReaderError.tooLarge }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func requestJSON(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await fetchJSON(request)
        guard (200..<300).contains(response.statusCode) else { throw ReaderError.http(response.statusCode) }
        guard data.count <= Self.maxBytes, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ReaderError.malformed }
        return object
    }

    private static func makeFetcher() -> @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse) {
        { request in
            let delegate = NoRedirectDelegate(); let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 15
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil); defer { session.invalidateAndCancel() }
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw ReaderError.transport }
            var data = Data(); data.reserveCapacity(16_384)
            for try await byte in bytes { guard data.count < Self.maxBytes else { throw ReaderError.tooLarge }; data.append(byte) }
            return (data, http)
        }
    }

    private struct ProviderResult: Sendable { let key: String; var windows: [QuotaWindow] = []; var issue: String? }
    enum ReaderError: Error { case tooLarge, malformed, transport, http(Int) }
}

private func number(_ value: Any?) -> Double? {
    if let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite { return n.doubleValue }
    if let s = value as? String, let d = Double(s), d.isFinite { return d }
    return nil
}
private func validToken(_ token: String) -> Bool { !token.isEmpty && !token.contains("\r") && !token.contains("\n") }
private func expiryDate(_ root: [String: Any]) -> Date? { guard let value = number(root["expires_at"] ?? root["expiresAt"]), value > 0, value.isFinite else { return nil }; return Date(timeIntervalSince1970: value / (value > 10_000_000_000 ? 1000 : 1)) }
private func iso8601(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
private func unknown(key: String, provider: String, label: String, observed: Date) -> QuotaWindow { QuotaWindow(id: "unknown", provider: provider, providerKey: key, providerLabel: label, via: provider, sourceApp: "local-mac", label: label, remainingUnknown: true, occurredAt: iso8601(observed), source: "local quota reader") }
private func errorMessage(_ error: Error, provider: String) -> String { if case AdditionalQuotaReader.ReaderError.http(401) = error { return "\(provider) needs you to sign in again." }; if case AdditionalQuotaReader.ReaderError.tooLarge = error { return "\(provider) returned an oversized response." }; return "\(provider) quota is unavailable." }

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
