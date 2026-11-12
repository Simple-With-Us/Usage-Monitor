import Foundation
import SQLite3

/// Reads Cursor's included subscription cap from Cursor.app's local session.  Browser cookies, cached sessions, OAuth refresh, and on-demand spend are
/// intentionally outside this reader's scope.
public struct CursorQuotaReader: Sendable {
    private let homeDirectory: URL
    private let now: @Sendable () -> Date
    private let fetch: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let accessToken: @Sendable () throws -> String?

    private static let maxResponseBytes = 1_048_576
    private static let timeout: TimeInterval = 15

    public init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        now: @escaping @Sendable () -> Date = { Date() },
        accessToken: (@Sendable () throws -> String?)? = nil,
        fetch: (@Sendable (URLRequest) async throws -> (Data, HTTPURLResponse))? = nil
    ) {
        let home = homeDirectory.standardizedFileURL
        self.homeDirectory = home
        self.now = now
        self.fetch = fetch ?? Self.makeFetcher()
        self.accessToken = accessToken ?? Self.makeSQLiteTokenReader(databaseURL: home.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb"))
    }

    public func read() async -> LocalQuotaResult {
        do {
            guard let token = try accessToken(), !token.isEmpty else {
                return LocalQuotaResult(issues: ["cursor": "Cursor is not signed in locally."])
            }
            guard let cookie = try cursorCookie(for: token, now: now()) else {
                return LocalQuotaResult(issues: ["cursor": "Cursor local session is not usable; sign in again in Cursor."])
            }
            var request = URLRequest(url: URL(string: "https://cursor.com/api/usage-summary")!)
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = Self.timeout
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await fetch(request)
            guard (200..<300).contains(response.statusCode) else {
                if response.statusCode == 401 || response.statusCode == 403 {
                    return LocalQuotaResult(issues: ["cursor": "Cursor session was rejected; sign in again in Cursor."])
                }
                return LocalQuotaResult(issues: ["cursor": "Cursor quota service is unavailable."])
            }
            guard data.count <= Self.maxResponseBytes,
                  let object = try? JSONSerialization.jsonObject(with: data),
                  let root = object as? [String: Any] else {
                return LocalQuotaResult(issues: ["cursor": "Cursor quota response was unavailable."])
            }
            let windows = parseSummary(root, observedAt: now())
            guard !windows.isEmpty else {
                return LocalQuotaResult(windows: [cursorUnknownWindow(observedAt: now())], issues: ["cursor": "Cursor returned no readable included quota."])
            }
            let issues = windows.allSatisfy { $0.remainingPercent == nil }
                ? ["cursor": "Cursor returned no readable included quota."]
                : [:]
            return LocalQuotaResult(windows: windows, issues: issues)
        } catch is CancellationError {
            return LocalQuotaResult(issues: ["cursor": "Cursor quota refresh was cancelled."])
        } catch let error as CursorQuotaError {
            return LocalQuotaResult(issues: ["cursor": error.message])
        } catch {
            return LocalQuotaResult(issues: ["cursor": "Cursor quota source is unavailable."])
        }
    }
}

private enum CursorQuotaError: Error {
    case invalidSession
    case unavailable

    var message: String {
        switch self {
        case .invalidSession: return "Cursor local session is not usable; sign in again in Cursor."
        case .unavailable: return "Cursor quota source is unavailable."
        }
    }
}

private func cursorCookie(for token: String, now: Date) throws -> String? {
    guard token.utf8.count <= 65_536, !token.contains("\r"), !token.contains("\n") else { throw CursorQuotaError.invalidSession }
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { throw CursorQuotaError.invalidSession }
    var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
    guard let payloadData = Data(base64Encoded: payload),
          let object = try? JSONSerialization.jsonObject(with: payloadData),
          let claims = object as? [String: Any],
          let subject = claims["sub"] as? String,
          let userID = subject.split(separator: "|", omittingEmptySubsequences: true).last.map(String.init),
          !userID.isEmpty,
          userID.unicodeScalars.allSatisfy(CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-")).contains),
          let expiration = claims["exp"] as? NSNumber,
          expiration.doubleValue.isFinite,
          Date(timeIntervalSince1970: expiration.doubleValue) > now.addingTimeInterval(60) else {
        throw CursorQuotaError.invalidSession
    }
    return "WorkosCursorSessionToken=\(userID)%3A%3A\(token)"
}

private func parseSummary(_ root: [String: Any], observedAt: Date) -> [QuotaWindow] {
    let individual = root["individualUsage"] as? [String: Any] ?? [:]
    let plan = individual["plan"] as? [String: Any]
    let reset = validCursorTimestamp(root["billingCycleEnd"])
    let planName = safeString(root["membershipType"])
    var windows: [QuotaWindow] = []
    if let plan {
        windows.append(cursorWindow(id: "plan", label: "Included plan", values: plan, resetAt: reset, planName: planName, observedAt: observedAt))
    }
    return windows
}

private func cursorWindow(id: String, label: String, values: [String: Any], resetAt: String?, planName: String?, observedAt: Date) -> QuotaWindow {
    let limitCents = finiteNumber(values["limit"])
    let remainingCents = finiteNumber(values["remaining"])
    let usedCents = finiteNumber(values["used"])
    let percentageUsed = finiteNumber(values["totalPercentUsed"])
    let remainingPercent: Double?
    if let limitCents, limitCents > 0, let remainingCents {
        remainingPercent = clampCursorPercent(remainingCents / limitCents * 100)
    } else if let limitCents, limitCents > 0, let usedCents {
        remainingPercent = clampCursorPercent((limitCents - usedCents) / limitCents * 100)
    } else if let percentageUsed {
        remainingPercent = clampCursorPercent(100 - percentageUsed)
    } else {
        remainingPercent = nil
    }
    let limitUSD = limitCents.flatMap { $0 > 0 ? $0 / 100 : nil }
    let remainingUSD = remainingCents.flatMap { limitUSD == nil ? nil : max(0, $0 / 100) }
        ?? limitCents.flatMap { limit in usedCents.map { max(0, (limit - $0) / 100) } }
    let bounded = remainingPercent
    let exhausted = bounded == 0
    return QuotaWindow(
        id: "local-mac:cursor:\(id)", provider: "Cursor", providerKey: "cursor", providerLabel: "Cursor",
        sourceApp: "local-mac", label: label, remainingPercent: bounded,
        absoluteRemaining: remainingUSD,
        absoluteLimit: limitUSD, quotaUnit: "USD", planName: planName,
        remainingUnknown: bounded == nil, isExhausted: exhausted, resetAt: resetAt, window: "billing-cycle",
        status: bounded == nil ? .unknown : exhausted ? .exhausted : bounded! < 20 ? .nearCap : .available,
        skip: exhausted, skipReason: exhausted ? "quota exhausted" : nil,
        occurredAt: cursorISOFormatter.string(from: observedAt), source: "Cursor"
    )
}

private func cursorUnknownWindow(observedAt: Date) -> QuotaWindow {
    QuotaWindow(id: "local-mac:cursor:unknown", provider: "Cursor", providerKey: "cursor", providerLabel: "Cursor", sourceApp: "local-mac", label: "Included plan", remainingUnknown: true, status: .unknown, occurredAt: cursorISOFormatter.string(from: observedAt), source: "Cursor")
}

private func finiteNumber(_ value: Any?) -> Double? {
    if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite { return number.doubleValue }
    if let string = value as? String, let number = Double(string), number.isFinite { return number }
    return nil
}

private func safeString(_ value: Any?) -> String? {
    guard let string = value as? String, !string.contains("\r"), !string.contains("\n") else { return nil }
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty || trimmed.utf8.count > 256 ? nil : trimmed
}

private func clampCursorPercent(_ value: Double) -> Double { min(100, max(0, value.isFinite ? value : 0)) }

private func validCursorTimestamp(_ value: Any?) -> String? {
    guard let string = safeString(value),
          ISO8601DateFormatter().date(from: string) != nil || cursorFractionalFormatter.date(from: string) != nil else { return nil }
    return string
}

private let cursorFractionalFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
}()

private let cursorISOFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
}()

private extension CursorQuotaReader {
    static func makeFetcher() -> @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse) {
        return { request in
            let delegate = CursorNoRedirectDelegate()
            let config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = timeout; config.timeoutIntervalForResource = timeout
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw CursorQuotaError.unavailable }
            if let length = http.value(forHTTPHeaderField: "Content-Length"), let count = Int(length), count > maxResponseBytes { throw CursorQuotaError.unavailable }
            var data = Data(); data.reserveCapacity(16_384)
            for try await byte in bytes {
                guard data.count < maxResponseBytes else { throw CursorQuotaError.unavailable }
                data.append(byte)
            }
            return (data, http)
        }
    }

    static func makeSQLiteTokenReader(databaseURL: URL) -> @Sendable () throws -> String? {
        return {
            guard FileManager.default.fileExists(atPath: databaseURL.path) else { return nil }
            var database: OpaquePointer?
            guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
                sqlite3_close(database); throw CursorQuotaError.unavailable
            }
            defer { sqlite3_close(database) }
            sqlite3_busy_timeout(database, 250)
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, "SELECT value FROM ItemTable WHERE key = ? LIMIT 1;", -1, &statement, nil) == SQLITE_OK else {
                sqlite3_finalize(statement); throw CursorQuotaError.unavailable
            }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, "cursorAuth/accessToken", -1, cursorSQLiteTransient)
            guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
            let type = sqlite3_column_type(statement, 0)
            let byteCount = Int(sqlite3_column_bytes(statement, 0))
            guard byteCount <= 65_536 else { throw CursorQuotaError.unavailable }
            if type == SQLITE_TEXT, let pointer = sqlite3_column_text(statement, 0) { return String(cString: pointer) }
            if type == SQLITE_BLOB, let pointer = sqlite3_column_blob(statement, 0) {
                let data = Data(bytes: pointer, count: byteCount)
                if let utf8 = String(data: data, encoding: .utf8) { return utf8 }
                return String(data: data, encoding: .utf16LittleEndian)
            }
            return nil
        }
    }
}

private let cursorSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class CursorNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
