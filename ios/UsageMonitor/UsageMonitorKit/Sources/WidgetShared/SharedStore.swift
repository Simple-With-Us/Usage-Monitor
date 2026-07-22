import Foundation

/// Protected app-group persistence for the compact widget projection.
///
/// The live app synchronously clears this store whenever its host or
/// authentication identity changes. No credential or credential fingerprint
/// is stored in the widget container. The file remains readable after the
/// first device unlock so WidgetKit and background refresh keep working.
public struct SharedStore {
    public static let shared = SharedStore()

    private static let schemaVersion = 2
    private static let maximumFileSize = 1 * 1_024 * 1_024
    private static let fileName = "widget-snapshot-v2.json"
    private static let legacyFileName = "widget-snapshot.json"
    private static let defaultsKey = "widget-snapshot-v2"
    private static let legacyDefaultsKey = "widget-snapshot"

    private let containerURL: URL?
    private let defaults: UserDefaults
    private let fileManager: FileManager

    public init(
        containerURL: URL? = AppGroup.containerURL,
        defaults: UserDefaults = AppGroup.defaults,
        fileManager: FileManager = .default
    ) {
        self.containerURL = containerURL
        self.defaults = defaults
        self.fileManager = fileManager
    }

    public func write(_ snapshot: WidgetSnapshot) {
        cleanupLegacyData()
        let envelope = SnapshotEnvelope(schemaVersion: Self.schemaVersion, snapshot: snapshot)
        guard let data = try? encoder.encode(envelope) else { return }

        guard let fileURL else {
            defaults.set(data, forKey: Self.defaultsKey)
            return
        }

        do {
            try data.write(to: fileURL, options: writingOptions)
            try hardenFile(at: fileURL)
        } catch {
            // Widget persistence is best-effort and must never fail a successful
            // budget refresh.
        }
    }

    public func read() -> WidgetSnapshot? {
        cleanupLegacyData()
        guard let fileURL else {
            guard let data = defaults.data(forKey: Self.defaultsKey) else { return nil }
            return decodeAndCleanFallback(data)
        }

        guard isSafeRegularFile(fileURL), isWithinSizeLimit(fileURL) else {
            try? fileManager.removeItem(at: fileURL)
            return nil
        }

        do {
            let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
            let envelope = try decoder.decode(SnapshotEnvelope.self, from: data)
            guard envelope.schemaVersion == Self.schemaVersion else {
                try? fileManager.removeItem(at: fileURL)
                return nil
            }
            return envelope.snapshot
        } catch {
            try? fileManager.removeItem(at: fileURL)
            return nil
        }
    }

    /// Synchronous identity boundary used before a host/auth setter returns.
    /// The next widget timeline renders ``WidgetSnapshot/empty`` until a fresh
    /// response for the new identity is stored.
    public func clear() {
        if let fileURL { try? fileManager.removeItem(at: fileURL) }
        if let legacyFileURL { try? fileManager.removeItem(at: legacyFileURL) }
        defaults.removeObject(forKey: Self.defaultsKey)
        defaults.removeObject(forKey: Self.legacyDefaultsKey)
    }

    // Internal paths are intentionally exposed only to @testable tests.
    var snapshotFileURL: URL? { fileURL }
    var legacySnapshotFileURL: URL? { legacyFileURL }

    private struct SnapshotEnvelope: Codable {
        let schemaVersion: Int
        let snapshot: WidgetSnapshot
    }

    private var fileURL: URL? {
        containerURL?.appendingPathComponent(Self.fileName, isDirectory: false)
    }

    private var legacyFileURL: URL? {
        containerURL?.appendingPathComponent(Self.legacyFileName, isDirectory: false)
    }

    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private var writingOptions: Data.WritingOptions {
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        return options
    }

    private func cleanupLegacyData() {
        if let legacyFileURL { try? fileManager.removeItem(at: legacyFileURL) }
        defaults.removeObject(forKey: Self.legacyDefaultsKey)
    }

    private func decodeAndCleanFallback(_ data: Data) -> WidgetSnapshot? {
        guard data.count <= Self.maximumFileSize,
              let envelope = try? decoder.decode(SnapshotEnvelope.self, from: data),
              envelope.schemaVersion == Self.schemaVersion
        else {
            defaults.removeObject(forKey: Self.defaultsKey)
            return nil
        }
        return envelope.snapshot
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
}
