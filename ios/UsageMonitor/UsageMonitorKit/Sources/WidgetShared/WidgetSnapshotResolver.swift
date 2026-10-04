import Foundation

#if canImport(WidgetKit)
import WidgetKit
#endif

/// Which app wrote the snapshot the widget is about to render.
///
/// Two separate iOS apps share `group.com.simplewithus.usage`:
///
/// - **Client** (`com.simplewithus.usage.client`) writes `widget-snapshot-v2.json`
///   through ``SharedStore``.
/// - **Local** (`com.simplewithus.usage.local`) writes `local-widget-snapshot.json`
///   through `LocalWidgetSnapshotWriter`.
///
/// Before this type existed, every widget read *only* the Client filename, so a
/// Local-only install rendered "Open the app to load ..." forever even though the
/// app itself was holding fresh data. The resolver picks whichever payload is
/// newest instead of assuming one writer.
public enum WidgetSnapshotSource: String, Codable, Sendable {
    case client
    case local
}

/// Why a widget render produced no data.  Surfaced in the app's Settings
/// diagnostics row so a silent empty widget becomes a visible, actionable state
/// instead of an unactionable "tap to load" loop.
public struct WidgetSnapshotDiagnostics: Equatable, Sendable {
    /// `false` when the app-group container is unavailable, which makes every
    /// app and the extension fall back to their *own* private `UserDefaults`
    /// and never see each other's payload. This is the failure that looks like
    /// "the app has data but the widget never gets it".
    public var containerAvailable: Bool
    public var source: WidgetSnapshotSource?
    public var generatedAt: Date?
    public var ageSeconds: TimeInterval?
    /// Client filename existed but failed schema/size/symlink validation.
    public var clientFileRejected: Bool
    /// Local filename existed but failed decoding.
    public var localFileRejected: Bool

    public var isUsable: Bool { source != nil }
}

/// Reads the freshest app-group snapshot regardless of which app wrote it, and
/// owns the single `WidgetCenter` reload throttle both apps use.
///
/// A `struct` with an injectable container rather than a bare `enum` of statics,
/// so the cross-app read logic is unit-testable against a temp directory — the
/// whole point of this type is a data-flow contract between two apps, which is
/// exactly the kind of thing that silently rots when it can only be exercised by
/// hand on a device.
public struct WidgetSnapshotResolver {
    /// Local's writer filename.  Declared here (not just in `LocalDataPlane`)
    /// because the reader has to know it, and `WidgetShared` cannot depend on
    /// `LocalDataPlane` without a cycle.
    public static let localFileName = "local-widget-snapshot.json"
    /// The Client's filename, owned by ``SharedStore``.  Named here only so the
    /// diagnostics can distinguish "rejected" from "never written".
    public static let clientFileName = "widget-snapshot-v2.json"

    public let containerURL: URL?
    private let store: SharedStore

    public init(containerURL: URL? = AppGroup.containerURL) {
        self.containerURL = containerURL
        self.store = SharedStore(containerURL: containerURL)
    }

    /// Production instance used by the widget extension and both apps.
    public static let shared = WidgetSnapshotResolver()

    // MARK: - Reading

    /// The snapshot the widget should render, or `nil` when neither app has
    /// written one.
    public func read() -> WidgetSnapshot? {
        readDetailed().snapshot
    }

    public func readDetailed(now: Date = Date()) -> (
        snapshot: WidgetSnapshot?,
        diagnostics: WidgetSnapshotDiagnostics
    ) {
        guard containerURL != nil else {
            return (
                nil,
                WidgetSnapshotDiagnostics(
                    containerAvailable: false,
                    source: nil,
                    generatedAt: nil,
                    ageSeconds: nil,
                    clientFileRejected: false,
                    localFileRejected: false
                )
            )
        }

        let client = store.read()
        let local = readLocalSnapshot()

        let chosen: WidgetSnapshot?
        let source: WidgetSnapshotSource?
        switch (client, local) {
        case let (c?, l?):
            if l.generatedAt > c.generatedAt {
                chosen = l
                source = .local
            } else {
                chosen = c
                source = .client
            }
        case let (c?, nil):
            chosen = c
            source = .client
        case let (nil, l?):
            chosen = l
            source = .local
        case (nil, nil):
            chosen = nil
            source = nil
        }

        return (
            chosen,
            WidgetSnapshotDiagnostics(
                containerAvailable: true,
                source: source,
                generatedAt: chosen?.generatedAt,
                ageSeconds: chosen.map { now.timeIntervalSince($0.generatedAt) },
                clientFileRejected: client == nil && fileExists(Self.clientFileName),
                localFileRejected: local == nil && fileExists(Self.localFileName)
            )
        )
    }

    /// Whether an unavailable widget should explain that the *app group* is
    /// broken rather than repeat "open the app".
    ///
    /// The old behaviour was a flat "Open the app to load ...", which is
    /// indistinguishable from "tap the app and it will work" — and that is
    /// exactly the loop Jay hit: the app loaded fine and the widget still
    /// said the same thing. When the app group itself is unavailable, no amount
    /// of tapping will ever help, so say that instead of repeating a dead end.
    public var isAppGroupUnavailable: Bool {
        !readDetailed().diagnostics.containerAvailable
    }

    // MARK: - Local payload

    /// Local writes a bare `WidgetSnapshot` with a default-configured
    /// `JSONEncoder`, so dates are `deferredToDate` (seconds since the 2001
    /// reference date) — **not** the Client's `.iso8601`.  Decoding it with the
    /// Client's decoder fails on every `Date`, which is why this is a separate
    /// decoder rather than a reuse of `SharedStore`'s.
    private func readLocalSnapshot() -> WidgetSnapshot? {
        guard let url = fileURL(Self.localFileName) else { return nil }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            return nil
        }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    private func fileURL(_ name: String) -> URL? {
        containerURL?.appendingPathComponent(name, isDirectory: false)
    }

    private func fileExists(_ name: String) -> Bool {
        guard let url = fileURL(name) else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }
}

/// Single process-wide `WidgetCenter` reload throttle, shared by both apps so a
/// burst of section writes inside one refresh costs one reload.
public enum WidgetTimelineReloader {
    private static let lock = NSLock()
    private static var lastReload = Date.distantPast
    private static let minimumReloadInterval: TimeInterval = 60

    public static func reload(force: Bool = false, now: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        guard force || now.timeIntervalSince(lastReload) >= minimumReloadInterval else {
            return
        }
        lastReload = now
        #if canImport(WidgetKit) && os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }
}
