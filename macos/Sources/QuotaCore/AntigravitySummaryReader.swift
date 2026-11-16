import Foundation

/// Reads the grouped Antigravity quota summary.  The default transport is left
/// injectable so callers can supply the running language-server connection
/// without exposing process credentials to this library.
public struct AntigravitySummaryReader: Sendable {
    private let now: @Sendable () -> Date
    private let fetchSummary: @Sendable () async throws -> Data

    public init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        now: @escaping @Sendable () -> Date = { Date() },
        fetchSummary: (@Sendable () async throws -> Data)? = nil
    ) {
        let home = homeDirectory.standardizedFileURL
        self.now = now
        self.fetchSummary = fetchSummary ?? Self.makeLocalFetcher(homeDirectory: home)
    }

    public func read() async -> LocalQuotaResult {
        do {
            let data = try await fetchSummary()
            guard data.count <= 1_048_576 else { throw SummaryError.tooLarge }
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SummaryError.malformed }
            let response = (root["response"] as? [String: Any]) ?? root
            let groups = (response["groups"] as? [[String: Any]]) ?? []
            let observed = now()
            var windows: [QuotaWindow] = []
            for group in groups {
                guard let displayName = group["displayName"] as? String else { continue }
                let family: String?
                if displayName.localizedCaseInsensitiveContains("gemini") { family = "Gemini" }
                else if displayName.localizedCaseInsensitiveContains("claude") || displayName.localizedCaseInsensitiveContains("gpt") || displayName.localizedCaseInsensitiveContains("third") { family = "Third-Party" }
                else { family = nil }
                guard let family else { continue }
                for bucket in (group["buckets"] as? [[String: Any]]) ?? [] {
                    guard let bucketID = bucket["bucketId"] as? String, let period = period(bucket) else { continue }
                    let fraction = finiteNumber(bucket["remainingFraction"]).flatMap { $0 >= 0 && $0 <= 1 ? $0 : nil }
                    let reset = bucket["resetTime"] as? String
                    let label = "\(family) · \(period == "5h" ? "5-Hour" : "Weekly")"
                    windows.append(QuotaWindow(id: "local-mac:antigravity-summary:\(bucketID)", provider: "Antigravity", providerKey: "google-antigravity", providerLabel: "Antigravity", via: "antigravity", sourceApp: "local-mac", label: label, remainingPercent: fraction.map { $0 * 100 }, remainingUnknown: fraction == nil, resetAt: reset, window: period, occurredAt: iso8601(observed), source: "Antigravity quota summary"))
                }
            }
            guard !windows.isEmpty else { throw SummaryError.malformed }
            return LocalQuotaResult(windows: windows)
        } catch is CancellationError { return LocalQuotaResult(issues: ["google-antigravity": "Antigravity quota refresh was cancelled."]) }
        catch SummaryError.tooLarge { return LocalQuotaResult(issues: ["google-antigravity": "Antigravity quota response is too large."]) }
        catch { return LocalQuotaResult(issues: ["google-antigravity": "Antigravity grouped quota is unavailable."]) }
    }

    private func period(_ bucket: [String: Any]) -> String? {
        let value = (bucket["window"] as? String)?.lowercased()
        if value == "5h" || value == "weekly" { return value }
        let id = (bucket["bucketId"] as? String)?.lowercased() ?? ""
        if id.hasSuffix("-5h") { return "5h" }
        if id.hasSuffix("-weekly") { return "weekly" }
        return nil
    }

    private static func makeLocalFetcher(homeDirectory: URL) -> @Sendable () async throws -> Data {
        {
            let deadline = ProcessInfo.processInfo.systemUptime + 20
            let pids = try await BoundedQuotaProcess().run(
                path: "/usr/bin/pgrep", arguments: ["-f", "language_server|language-server|/agy( |$)"],
                home: homeDirectory, timeout: 2, maxBytes: 16_384)
            var candidates = 0
            for line in String(decoding: pids, as: UTF8.self).split(whereSeparator: \.isNewline).reversed() {
                try Task.checkCancellation()
                guard candidates < 4, ProcessInfo.processInfo.systemUptime < deadline else { break }
                guard let pid = Int32(line.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0,
                      let commandData = try? await BoundedQuotaProcess().run(
                        path: "/bin/ps", arguments: ["-p", "\(pid)", "-o", "command="],
                        home: homeDirectory, timeout: 2, maxBytes: 65_536) else { continue }
                let command = String(decoding: commandData, as: UTF8.self)
                let identity = command.lowercased()
                let cli = identity.contains("/antigravity-cli/") || identity.contains("/antigravity_cli/")
                    || identity.split(whereSeparator: \.isWhitespace).first?.hasSuffix("/agy") == true
                guard cli || identity.contains("/antigravity/") || identity.contains("antigravity.app/")
                    || identity.contains("antigravity ide.app/") || identity.contains("--app_data_dir antigravity") else { continue }
                let csrf = argument(command, names: ["--csrf_token", "--csrf-token"]) ?? ""
                guard (cli && csrf.isEmpty) || validHeader(csrf) else { continue }
                candidates += 1
                var ports: [Int] = []
                if let lsof = try? await BoundedQuotaProcess().run(
                    path: "/usr/sbin/lsof", arguments: ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", "\(pid)", "-Fn"],
                    home: homeDirectory, timeout: 2, maxBytes: 16_384) {
                    ports = lsofPorts(String(decoding: lsof, as: UTF8.self))
                }
                for name in ["--https_server_port", "--extension_server_port"] {
                    if let port = argument(command, names: [name]).flatMap(Int.init), !ports.contains(port) { ports.append(port) }
                }
                for port in ports.filter({ (1...65535).contains($0) }).prefix(4) {
                    for scheme in ["https", "http"] {
                        try Task.checkCancellation()
                        guard ProcessInfo.processInfo.systemUptime < deadline else { throw SummaryError.unavailable }
                        let url = URL(string: "\(scheme)://127.0.0.1:\(port)/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary")!
                        var request = URLRequest(url: url)
                        request.httpMethod = "POST"
                        request.httpBody = Data("{}".utf8)
                        request.timeoutInterval = min(3, deadline - ProcessInfo.processInfo.systemUptime)
                        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                        request.setValue("application/json", forHTTPHeaderField: "Accept")
                        request.setValue("1", forHTTPHeaderField: "Connect-Protocol-Version")
                        if !csrf.isEmpty { request.setValue(csrf, forHTTPHeaderField: "X-Codeium-Csrf-Token") }
                        do {
                            let data = try await Self.fetch(request)
                            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                            let response = root["response"] as? [String: Any] ?? root
                            if let groups = response["groups"] as? [[String: Any]], !groups.isEmpty { return data }
                        } catch is CancellationError { throw CancellationError() }
                        catch { continue }
                    }
                }
            }
            throw SummaryError.unavailable
        }
    }

    private static func fetch(_ request: URLRequest) async throws -> Data {
        let delegate = LocalTLSDelegate(); let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = request.timeoutInterval; config.timeoutIntervalForResource = request.timeoutInterval; config.httpCookieStorage = nil; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil); defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw SummaryError.unavailable }
        var data = Data(); data.reserveCapacity(16_384)
        for try await byte in bytes { guard data.count < 1_048_576 else { throw SummaryError.tooLarge }; data.append(byte) }
        return data
    }

    private enum SummaryError: Error { case unavailable, tooLarge, malformed }
}

private func finiteNumber(_ value: Any?) -> Double? {
    if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite { return number.doubleValue }
    if let string = value as? String, let number = Double(string), number.isFinite { return number }
    return nil
}

private func iso8601(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
private func validHeader(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= 4096 && !value.contains("\r") && !value.contains("\n") }
private func argument(_ command: String, names: [String]) -> String? {
    let tokens = command.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
    for (index, item) in tokens.enumerated() {
        for name in names where item.hasPrefix(name + "=") { return String(item.dropFirst(name.count + 1)) }
        if names.contains(item), index + 1 < tokens.count { return tokens[index + 1] }
    }
    return nil
}
private func lsofPorts(_ output: String) -> [Int] {
    output.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).compactMap { line in
        guard line.hasPrefix("n"), let value = line.split(separator: ":").last else { return nil }
        let port = value.prefix(while: { $0.isNumber })
        return Int(port)
    }
}

private final class LocalTLSDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.host == "127.0.0.1", challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust { completionHandler(.useCredential, URLCredential(trust: trust)) } else { completionHandler(.performDefaultHandling, nil) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
