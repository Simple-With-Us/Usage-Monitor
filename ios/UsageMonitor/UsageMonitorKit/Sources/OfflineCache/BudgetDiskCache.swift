import CryptoKit
import Foundation
import Models
import Networking

/// Protected disk persistence for the last successful budget response.
///
/// Cached spend is scoped to the active server and bearer credential, so a
/// host or account switch can never paint another identity's money data. Only
/// a SHA-256 digest of that identity is used on disk; the credential itself is
/// never persisted here. Session-cookie authentication has no user identifier
/// in the current server contract, so it is isolated by server host.
///
/// The app-group cache remains available after the first device unlock so
/// background refresh can preserve offline-first behavior. Files are excluded
/// from backup and use complete-until-first-authentication data protection.
public struct BudgetDiskCache {
    private static let schemaVersion = 2
    private static let namespaceName = "budget-cache-v2"
    private static let defaultFileName = "budget-status-cache.json"
    private static let maximumFileSize = 10 * 1_024 * 1_024

    private let fileManager: FileManager
    private let namespaceURL: URL
    private let scopeDirectoryURL: URL
    private let fileURL: URL
    private let legacyFileURL: URL
    private let scopeDigest: String
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// - Parameters:
    ///   - directory: Defaults to the app's Caches directory. Pass the app-group
    ///     container to share the cache with background integrations.
    ///   - fileName: Cache leaf name. Path traversal input falls back to the
    ///     default name.
    ///   - scopeIdentifier: An injectable server/account identity for tests.
    ///     Production callers omit it and derive the current host + bearer
    ///     credential fingerprint from the existing app configuration.
    public init(
        directory: URL? = nil,
        fileName: String = "budget-status-cache.json",
        scopeIdentifier: String? = nil,
        fileManager: FileManager = .default
    ) {
        let base = directory
            ?? fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let safeFileName = Self.safeLeafName(fileName)
        let scopeDigest = Self.digest(scopeIdentifier ?? Self.liveScopeIdentifier())
        let namespaceURL = base.appendingPathComponent(Self.namespaceName, isDirectory: true)
        let scopeDirectoryURL = namespaceURL.appendingPathComponent(scopeDigest, isDirectory: true)

        self.fileManager = fileManager
        self.namespaceURL = namespaceURL
        self.scopeDirectoryURL = scopeDirectoryURL
        self.fileURL = scopeDirectoryURL.appendingPathComponent(safeFileName, isDirectory: false)
        self.legacyFileURL = base.appendingPathComponent(safeFileName, isDirectory: false)
        self.scopeDigest = scopeDigest

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    /// Persist the response atomically, stamping it with the current time.
    /// Caching is best-effort; an I/O failure never fails a successful refresh.
    public func save(_ response: BudgetStatusResponse) {
        saveEntry(CachedBudget(response: response, cachedAt: Date()))
    }

    /// Persist a pre-built entry while preserving its explicit cache time.
    public func saveEntry(_ entry: CachedBudget) {
        do {
            try prepareScopeDirectory()
            let envelope = CacheEnvelope(
                schemaVersion: Self.schemaVersion,
                scopeDigest: scopeDigest,
                entry: entry
            )
            let data = try encoder.encode(envelope)
            try data.write(to: fileURL, options: writingOptions)
            try hardenFile(at: fileURL)
        } catch {
            // The network response remains authoritative; cache persistence is
            // deliberately non-fatal.
        }
    }

    /// The most recently cached response for the active identity.
    public func load() -> BudgetStatusResponse? {
        loadEntry()?.response
    }

    /// The active identity's timestamped cache entry, or `nil` when missing,
    /// oversized, from another identity/schema, or unreadable.
    public func loadEntry() -> CachedBudget? {
        cleanupObsoleteData()
        guard isSafeRegularFile(fileURL), isWithinSizeLimit(fileURL) else {
            try? fileManager.removeItem(at: fileURL)
            return nil
        }
        do {
            let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
            let envelope = try decoder.decode(CacheEnvelope.self, from: data)
            guard envelope.schemaVersion == Self.schemaVersion,
                  envelope.scopeDigest == scopeDigest
            else {
                try? fileManager.removeItem(at: fileURL)
                return nil
            }
            return envelope.entry
        } catch {
            // A corrupt cache should not be retried on every launch.
            try? fileManager.removeItem(at: fileURL)
            return nil
        }
    }

    /// Remove all budget-cache identities plus the pre-v2 unscoped file. Used
    /// on sign-out / token or host changes.
    public func clear() {
        try? fileManager.removeItem(at: namespaceURL)
        try? fileManager.removeItem(at: legacyFileURL)
    }

    // Internal paths are intentionally available only to the iOS test target.
    var cacheFileURL: URL { fileURL }
    var cacheNamespaceURL: URL { namespaceURL }

    private struct CacheEnvelope: Codable {
        let schemaVersion: Int
        let scopeDigest: String
        let entry: CachedBudget
    }

    private var writingOptions: Data.WritingOptions {
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return options
    }

    private func prepareScopeDirectory() throws {
        cleanupObsoleteData()
        try fileManager.createDirectory(
            at: scopeDirectoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try hardenDirectory(at: namespaceURL)
        try hardenDirectory(at: scopeDirectoryURL)
    }

    /// Keep one active identity only. This both bounds storage and removes data
    /// that could otherwise reappear after a later credential switch.
    private func cleanupObsoleteData() {
        try? fileManager.removeItem(at: legacyFileURL)

        guard let children = try? fileManager.contentsOfDirectory(
            at: namespaceURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for child in children where child.lastPathComponent != scopeDigest {
            try? fileManager.removeItem(at: child)
        }
    }

    private func isSafeRegularFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey,
        ]) else { return false }
        return values.isRegularFile == true && values.isSymbolicLink != true
    }

    private func isWithinSizeLimit(_ url: URL) -> Bool {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber
        else { return false }
        return size.intValue <= Self.maximumFileSize
    }

    private func hardenDirectory(at url: URL) throws {
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: url.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
        #if os(iOS)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        #endif
    }

    private func hardenFile(at url: URL) throws {
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
    }

    private static func liveScopeIdentifier() -> String {
        let rawHost = UserDefaults.standard.string(forKey: "settings.baseHost") ?? ""
        let configuration = APIConfiguration.fromUserInput(rawHost) ?? .production
        let token = KeychainTokenStore().token()?.trimmingCharacters(in: .whitespacesAndNewlines)
        return scopeIdentifier(baseURL: configuration.baseURL, bearerToken: token)
    }

    static func scopeIdentifier(baseURL: URL, bearerToken: String?) -> String {
        let host = canonicalServerIdentifier(baseURL)
        let token = bearerToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        let credential = token.flatMap { $0.isEmpty ? nil : digest($0) } ?? "session"
        return "server:\(host)|credential:\(credential)"
    }

    private static func canonicalServerIdentifier(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        components.query = nil
        components.fragment = nil
        if components.path.count > 1, components.path.hasSuffix("/") {
            components.path.removeLast()
        }
        return components.string ?? url.absoluteString
    }

    private static func safeLeafName(_ candidate: String) -> String {
        let leaf = URL(fileURLWithPath: candidate).lastPathComponent
        guard !leaf.isEmpty, leaf != ".", leaf != "..", leaf == candidate else {
            return defaultFileName
        }
        return leaf
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
