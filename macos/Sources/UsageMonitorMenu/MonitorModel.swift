import Combine
import Foundation
import QuotaCore

enum DisplayMode: String, CaseIterable, Identifiable {
    case menuBar, dock, both
    var id: String { rawValue }
    var title: String {
        switch self {
        case .menuBar: return "Menu Bar"
        case .dock: return "Dock"
        case .both: return "Both"
        }
    }
}

public enum QuotaViewLayout: String, CaseIterable, Identifiable {
    case allAtOnce = "allAtOnce"
    case detailed = "detailed"
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .allAtOnce: return "All at Once"
        case .detailed: return "Detailed"
        }
    }
}

@MainActor
final class MonitorModel: ObservableObject {
    @Published var displayMode: DisplayMode {
        didSet { defaults.set(displayMode.rawValue, forKey: "displayMode") }
    }
    @Published var viewLayout: QuotaViewLayout {
        didSet { defaults.set(viewLayout.rawValue, forKey: "quotaViewLayout") }
    }
    @Published private(set) var response = QuotaResponse(generatedAt: "")
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastChecked: Date?
    @Published private(set) var issues: [String: String] = [:]
    @Published private(set) var serverError: String?
    @Published private(set) var handoffError: String?
    @Published private(set) var now = Date()
    @Published private(set) var localEnabled: Bool
    @Published private(set) var serverEnabled: Bool
    @Published private(set) var endpoint: String
    @Published private(set) var hasSavedToken: Bool
    @Published private(set) var connectingClaude = false
    @Published private(set) var claudeConnectionMessage: String?
    private var claudeCredential: Data?
    private var sessionToken: String?
    private let defaults: UserDefaults
    private var localWindows: [QuotaWindow] = []
    private var serverWindows: [QuotaWindow] = []
    private var refreshTimer: Timer?
    private var clockTimer: Timer?
    private var request: Task<Void, Never>?
    private var revision = 0

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        displayMode = DisplayMode(rawValue: defaults.string(forKey: "displayMode") ?? "") ?? .both
        viewLayout = QuotaViewLayout(rawValue: defaults.string(forKey: "quotaViewLayout") ?? "") ?? .allAtOnce
        localEnabled = defaults.object(forKey: "localEnabled") as? Bool ?? true
        serverEnabled = defaults.bool(forKey: "serverEnabled")
        let savedEndpoint = defaults.string(forKey: "endpoint") ?? "https://usage.jays.services/api/quota-windows"
        endpoint = savedEndpoint
        hasSavedToken = defaults.bool(forKey: "hasSavedToken")
    }

    var sections: [QuotaPlatformSection] { response.platformSections(now: now) }
    var freshWindows: [QuotaWindowSnapshot] {
        sections.flatMap(\.windows).filter {
            $0.isFresh && $0.remainingPercent != nil && !$0.window.isSupplementaryVideoQuota && issues[$0.window.canonicalProviderKey] == nil
        }
    }
    var reportingCount: Int { Set(freshWindows.map { $0.window.canonicalProviderKey }).count }
    var nearCapCount: Int { freshWindows.filter { ($0.remainingPercent ?? 100) <= 20 }.count }
    var nextReset: Date? { freshWindows.compactMap(\.resetAt).filter { $0 > now }.min() }
    var menuBarTitle: String {
        guard let lowest = freshWindows.compactMap(\.remainingPercent).min() else { return "UM —" }
        return "UM \(Int(lowest.rounded()))%"
    }
    var menuBarDetail: String {
        guard let lowest = freshWindows.min(by: { ($0.remainingPercent ?? 100) < ($1.remainingPercent ?? 100) }) else {
            return "No current quota report"
        }
        return "\(sections.first { $0.providerKey == lowest.window.canonicalProviderKey }?.providerLabel ?? lowest.window.provider), \(lowest.window.label): \(Int((lowest.remainingPercent ?? 0).rounded()))% remaining"
    }

    func start() {
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        clockTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.now = Date() }
        }
    }

    func stop() {
        revision += 1
        request?.cancel()
        request = nil
        isRefreshing = false
        refreshTimer?.invalidate()
        clockTimer?.invalidate()
    }

    func connectClaude() async {
        guard !connectingClaude else { return }
        connectingClaude = true
        claudeConnectionMessage = nil
        defer { connectingClaude = false }
        let data = await ClaudeCredentialSource.connect()
        guard let data,
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let oauth = root["claudeAiOauth"] as? [String: Any],
              let token = (oauth["accessToken"] ?? oauth["access_token"]) as? String,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            claudeCredential = nil
            claudeConnectionMessage = "Usage Monitor could not read a Claude quota credential.  Your Claude login has not been changed."
            restartRefresh()
            return
        }
        claudeCredential = data
        claudeConnectionMessage = "Claude credential loaded for this app session."
        restartRefresh()
    }

    private func restartRefresh() {
        revision += 1
        request?.cancel()
        request = nil
        isRefreshing = false
        refresh()
    }

    func saveConnection(local: Bool, server: Bool, endpoint input: String, token: String) async throws {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), QuotaClient.isAllowedEndpoint(url) else { throw QuotaClientError.invalidEndpoint }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanToken.isEmpty {
            guard !cleanToken.contains("\n"), !cleanToken.contains("\r") else { throw QuotaClientError.invalidToken }
            try await TokenStore.save(cleanToken, server: value)
        }
        let cachedToken = value == endpoint ? sessionToken : nil
        let savedToken: String?
        if !cleanToken.isEmpty { savedToken = cleanToken }
        else if server, let cachedToken { savedToken = cachedToken }
        else if server { savedToken = await TokenStore.read(server: value) }
        else { savedToken = nil }
        if server && savedToken == nil { throw QuotaClientError.invalidToken }
        let saved = savedToken != nil || (value == endpoint && hasSavedToken)
        revision += 1
        request?.cancel()
        request = nil
        isRefreshing = false
        localEnabled = local
        serverEnabled = server
        endpoint = value
        sessionToken = savedToken
        hasSavedToken = saved
        defaults.set(saved, forKey: "hasSavedToken")
        defaults.set(local, forKey: "localEnabled")
        defaults.set(server, forKey: "serverEnabled")
        defaults.set(value, forKey: "endpoint")
        // A settings change is an identity boundary; never carry the previous server's data.
        localWindows = []
        serverWindows = []
        response = QuotaResponse(generatedAt: "")
        issues = [:]
        serverError = nil
        lastChecked = nil
        refresh()
    }

    func forgetServer() async throws {
        try await TokenStore.delete(server: endpoint)
        hasSavedToken = false
        defaults.set(false, forKey: "hasSavedToken")
        try await saveConnection(local: localEnabled, server: false, endpoint: endpoint, token: "")
    }

    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        let generation = revision
        let useLocal = localEnabled
        let useServer = serverEnabled
        let currentEndpoint = endpoint
        let token = sessionToken
        let credential = claudeCredential
        request = Task { [weak self] in
            async let localRead: LocalQuotaResult? = useLocal ? Self.readLocalSources(claudeCredential: credential) : nil
            var newServer: QuotaResponse?
            var failure: String?
            if useServer {
                do {
                    guard let url = URL(string: currentEndpoint) else { throw QuotaClientError.invalidEndpoint }
                    guard let token else { throw TokenStore.Failure.read }
                    let client = try QuotaClient(endpoint: url, token: token)
                    newServer = try await client.fetch()
                } catch is CancellationError { return }
                catch { failure = (error as? LocalizedError)?.errorDescription ?? "Unable to refresh the server." }
            }
            let local = await localRead
            guard !Task.isCancelled, let self, self.revision == generation else { return }
            self.now = Date()
            self.lastChecked = self.now
            if let local {
                self.issues = local.issues
                // A CLI may have changed accounts between reads.  Drop its old report on failure.
                self.localWindows = AntigravityQuotaGroups.normalize(local.windows)
            } else {
                self.issues = [:]
                self.localWindows = []
            }
            do {
                if useLocal { try LocalQuotaSnapshot.write(windows: self.localWindows, now: self.now) }
                else { try LocalQuotaSnapshot.remove() }
                self.handoffError = nil
            } catch {
                self.handoffError = "BotFleet quota sharing is unavailable."
            }
            if let newServer { self.serverWindows = newServer.platformSections(now: self.now).flatMap { $0.windows.map(\.window) } }
            if !useServer { self.serverWindows = [] }
            self.serverError = failure
            let localProviders = Set(self.localWindows.map(\.canonicalProviderKey))
            // Provider identity is the merge boundary; the server may track
            // another account, so do not borrow its weekly cap for a local login.
            let supplemental = self.serverWindows.filter { !localProviders.contains($0.canonicalProviderKey) }
            let serverProviders = Set(supplemental.map(\.canonicalProviderKey))
            let merged = self.localWindows.filter { !serverProviders.contains($0.canonicalProviderKey) } + supplemental
            for provider in serverProviders {
                self.issues[provider] = failure.map { "Server refresh failed.  Showing the last report.  \($0)" }
            }
            self.response = QuotaResponse(generatedAt: ISO8601DateFormatter().string(from: self.now), windows: merged)
            self.isRefreshing = false
            self.request = nil
        }
    }

    private nonisolated static func readLocalSources(claudeCredential: Data?) async -> LocalQuotaResult {
        async let primary = LocalQuotaReader(claudeCredential: claudeCredential).read()
        async let cursor = CursorQuotaReader().read()
        async let grokBot = GrokBotQuotaReader().read()
        async let antigravity = AntigravitySummaryReader().read()
        let results = await [primary, cursor, grokBot]
        let summary = await antigravity
        var windows = results.flatMap(\.windows)
        var issues = results.reduce(into: [String: String]()) { $0.merge($1.issues) { _, next in next } }
        // Use one Antigravity identity/source per refresh.  Never mix a local
        // CLI account with the helper's OAuth account to fill missing periods.
        if summary.windows.contains(where: { $0.boundedRemainingPercent != nil }) {
            windows.removeAll { $0.canonicalProviderKey == "google-antigravity" }
            windows += summary.windows
            issues["google-antigravity"] = nil
        }
        return LocalQuotaResult(windows: windows, issues: issues)
    }
}

func resetCountdown(_ reset: Date?, now: Date) -> String {
    guard let reset else { return "Reset time unavailable" }
    let seconds = reset.timeIntervalSince(now)
    guard seconds > 0 else { return "Reset passed · awaiting refresh" }
    let minutes = max(1, Int(ceil(seconds / 60)))
    if minutes >= 1440 { return "Resets in \(minutes / 1440)d \((minutes % 1440) / 60)h" }
    if minutes >= 60 { return "Resets in \(minutes / 60)h \(minutes % 60)m" }
    return "Resets in \(minutes)m"
}
