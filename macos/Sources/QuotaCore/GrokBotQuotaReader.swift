import Foundation
import SQLite3

/// Reads Grok Bot's separate weekly allowance from Cursor's DashboardService.
///
/// Grok Bot uses the Cursor account for authentication, but its included
/// allowance is a separate meter from Cursor's monthly model pools.  This
/// reader intentionally emits only the included weekly meter; on-demand
/// spending and Cursor model usage belong to other readers.
public struct GrokBotQuotaReader: Sendable {
    private let now: @Sendable () -> Date
    private let fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let accessToken: @Sendable () throws -> String?

    private static let endpoint = URL(string: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus")!
    private static let clientType = "sand"
    private static let clientVersion = "0.47.0"
    private static let boxNamespace = "prod"
    private static let maxResponseBytes = 1_048_576
    fileprivate static let maxTokenBytes = 65_536
    private static let timeout: TimeInterval = 15

    public init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        now: @escaping @Sendable () -> Date = { Date() },
        accessToken: (@Sendable () throws -> String?)? = nil,
        fetch: (@Sendable (URLRequest) async throws -> (Data, HTTPURLResponse))? = nil
    ) {
        let home = homeDirectory.standardizedFileURL
        self.now = now
        self.accessToken = accessToken ?? Self.makeSQLiteTokenReader(
            databaseURL: home.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
        )
        self.fetch = fetch ?? Self.makeFetcher()
    }

    public func read() async -> LocalQuotaResult {
        do {
            guard let token = try accessToken(), grokBotSafeToken(token) else {
                return LocalQuotaResult(issues: ["grok-bot": "Grok Bot requires a signed-in Cursor account."])
            }

            var request = URLRequest(url: Self.endpoint)
            request.httpMethod = "POST"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = Self.timeout
            request.httpBody = Data("{}".utf8)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
            request.setValue(Self.clientType, forHTTPHeaderField: "x-cursor-client-type")
            request.setValue(Self.clientVersion, forHTTPHeaderField: "x-cursor-client-version")
            request.setValue(Self.boxNamespace, forHTTPHeaderField: "x-sand-box-namespace")
            request.setValue("true", forHTTPHeaderField: "x-ghost-mode")

            let (data, response) = try await fetch(request)
            guard (200..<300).contains(response.statusCode) else {
                if response.statusCode == 401 || response.statusCode == 403 {
                    return LocalQuotaResult(issues: ["grok-bot": "Grok Bot session was rejected; sign in again in Cursor."])
                }
                return LocalQuotaResult(issues: ["grok-bot": "Grok Bot quota service is unavailable."])
            }
            guard data.count <= Self.maxResponseBytes,
                  let object = try? JSONSerialization.jsonObject(with: data),
                  let root = object as? [String: Any] else {
                return LocalQuotaResult(issues: ["grok-bot": "Grok Bot quota response was unavailable."])
            }

            guard let window = grokBotWindow(root, observedAt: now()) else {
                return LocalQuotaResult(
                    windows: [grokBotUnknownWindow(observedAt: now())],
                    issues: ["grok-bot": "Grok Bot returned no readable included weekly quota."]
                )
            }
            return LocalQuotaResult(windows: [window])
        } catch is CancellationError {
            return LocalQuotaResult(issues: ["grok-bot": "Grok Bot quota refresh was cancelled."])
        } catch is GrokBotQuotaError {
            return LocalQuotaResult(issues: ["grok-bot": "Grok Bot quota source is unavailable."])
        } catch {
            return LocalQuotaResult(issues: ["grok-bot": "Grok Bot quota source is unavailable."])
        }
    }
}

private enum GrokBotQuotaError: Error {
    case unavailable
}

private func grokBotSafeToken(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= GrokBotQuotaReader.maxTokenBytes && !value.contains("\r") && !value.contains("\n")
}

private func grokBotWindow(_ root: [String: Any], observedAt: Date) -> QuotaWindow? {
    let pooled = grokBotBool(root["usesPooledEnterpriseAllowance"] ?? root["uses_pooled_enterprise_allowance"]) == true
    let hasNonZeroIncludedLimit = grokBotBool(root["hasNonZeroIncludedLimit"] ?? root["has_non_zero_included_limit"])
    let includedLimitZero = grokBotBool(root["includedLimitZero"] ?? root["included_limit_zero"]) == true
    guard !pooled,
          hasNonZeroIncludedLimit != false,
          !includedLimitZero,
          let used = grokBotNumber(root["usagePercent"] ?? root["usage_percent"]),
          used.isFinite,
          used >= 0 else { return nil }

    let boundedUsed = min(100, max(0, used))
    let remaining = 100 - boundedUsed
    let reset = grokBotTimestamp(root["nextResetTimestampUtc"] ?? root["next_reset_timestamp_utc"])
    let plan = grokBotSafeString(root["grokPlanLabel"] ?? root["grok_plan_label"])
    let exhausted = remaining == 0

    return QuotaWindow(
        id: "local-mac:grok-bot:weekly",
        provider: "Grok Bot",
        providerKey: "grok-bot",
        providerLabel: "Grok Bot",
        via: "cursor",
        sourceApp: "local-mac",
        label: "Grok Bot weekly",
        remainingPercent: remaining,
        planName: plan,
        remainingUnknown: false,
        isExhausted: exhausted,
        resetAt: reset,
        window: "weekly",
        status: exhausted ? .exhausted : remaining < 20 ? .nearCap : .available,
        skip: exhausted,
        skipReason: exhausted ? "quota exhausted" : nil,
        occurredAt: grokBotISOFormatter.string(from: observedAt),
        source: "Cursor DashboardService"
    )
}

private func grokBotUnknownWindow(observedAt: Date) -> QuotaWindow {
    QuotaWindow(
        id: "local-mac:grok-bot:unknown",
        provider: "Grok Bot",
        providerKey: "grok-bot",
        providerLabel: "Grok Bot",
        via: "cursor",
        sourceApp: "local-mac",
        label: "Grok Bot weekly",
        remainingUnknown: true,
        status: .unknown,
        occurredAt: grokBotISOFormatter.string(from: observedAt),
        source: "Cursor DashboardService"
    )
}

private func grokBotNumber(_ value: Any?) -> Double? {
    if let number = value as? NSNumber,
       CFGetTypeID(number) != CFBooleanGetTypeID(),
       number.doubleValue.isFinite { return number.doubleValue }
    if let string = value as? String,
       string.utf8.count <= 64,
       let number = Double(string),
       number.isFinite { return number }
    return nil
}

private func grokBotBool(_ value: Any?) -> Bool? {
    if let value = value as? Bool { return value }
    return nil
}

private func grokBotSafeString(_ value: Any?) -> String? {
    guard let string = value as? String,
          string.utf8.count <= 256,
          !string.contains("\r"),
          !string.contains("\n") else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func grokBotTimestamp(_ value: Any?) -> String? {
    if let string = value as? String {
        guard string.utf8.count <= 128 else { return nil }
        if let date = grokBotDateFormatter.date(from: string) ?? grokBotFractionalDateFormatter.date(from: string) {
            return grokBotISOFormatter.string(from: date)
        }
        if let seconds = Double(string), seconds.isFinite { return grokBotTimestamp(seconds) }
        return nil
    }
    if let number = grokBotNumber(value) { return grokBotTimestamp(number) }
    if let object = value as? [String: Any], let seconds = grokBotNumber(object["seconds"]) {
        let nanos = grokBotNumber(object["nanos"]) ?? 0
        guard nanos.isFinite, abs(nanos) <= 999_999_999 else { return nil }
        return grokBotTimestamp(seconds + nanos / 1_000_000_000)
    }
    return nil
}

private func grokBotTimestamp(_ value: Double) -> String? {
    let seconds = abs(value) > 10_000_000_000 ? value / 1_000 : value
    guard value.isFinite, seconds.isFinite, abs(seconds) <= 4_102_444_800 else { return nil }
    let date = Date(timeIntervalSince1970: seconds)
    guard date.timeIntervalSince1970.isFinite else { return nil }
    return grokBotISOFormatter.string(from: date)
}

private let grokBotDateFormatter: ISO8601DateFormatter = ISO8601DateFormatter()
private let grokBotFractionalDateFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()
private let grokBotISOFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private extension GrokBotQuotaReader {
    static func makeSQLiteTokenReader(databaseURL: URL) -> @Sendable () throws -> String? {
        return {
            guard FileManager.default.fileExists(atPath: databaseURL.path) else { return nil }
            var database: OpaquePointer?
            guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
                sqlite3_close(database)
                throw GrokBotQuotaError.unavailable
            }
            defer { sqlite3_close(database) }
            sqlite3_busy_timeout(database, 250)

            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, "SELECT value FROM ItemTable WHERE key = ? LIMIT 1;", -1, &statement, nil) == SQLITE_OK else {
                sqlite3_finalize(statement)
                throw GrokBotQuotaError.unavailable
            }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, "cursorAuth/accessToken", -1, grokBotSQLiteTransient)
            guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
            let byteCount = Int(sqlite3_column_bytes(statement, 0))
            guard byteCount <= GrokBotQuotaReader.maxTokenBytes else { throw GrokBotQuotaError.unavailable }
            let type = sqlite3_column_type(statement, 0)
            let value: String?
            if type == SQLITE_TEXT, let pointer = sqlite3_column_text(statement, 0) {
                value = String(cString: pointer)
            } else if type == SQLITE_BLOB, let pointer = sqlite3_column_blob(statement, 0) {
                value = String(data: Data(bytes: pointer, count: byteCount), encoding: .utf8)
            } else {
                value = nil
            }
            guard let value, !value.isEmpty else { return nil }
            if value.first == "\"", let decoded = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? String {
                return decoded
            }
            return value
        }
    }

    static func makeFetcher() -> @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse) {
        { request in
            let delegate = GrokBotNoRedirectDelegate()
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = timeout
            configuration.timeoutIntervalForResource = timeout
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw GrokBotQuotaError.unavailable }
            if let length = http.value(forHTTPHeaderField: "Content-Length"), let count = Int(length), count > maxResponseBytes {
                throw GrokBotQuotaError.unavailable
            }
            var data = Data()
            data.reserveCapacity(16_384)
            for try await byte in bytes {
                guard data.count < maxResponseBytes else { throw GrokBotQuotaError.unavailable }
                data.append(byte)
            }
            return (data, http)
        }
    }
}

private let grokBotSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class GrokBotNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
