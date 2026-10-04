import XCTest
import WidgetShared

/// Regression coverage for the two app-group defects that made every iOS widget
/// read "Open the app to load ..." forever (owner report 2026-10-04):
///
/// 1. The Local app wrote `local-widget-snapshot.json` while every widget
///    provider only ever read the Client's `widget-snapshot-v2.json`, so a
///    Local-only install had a file nobody could see.
/// 2. The Local app never asked WidgetKit to re-read, so even a correct payload
///    would wait out the 30-minute timeline policy.
///
/// The Local payload is a **bare** `WidgetSnapshot` encoded with a
/// default-configured `JSONEncoder` (so `deferredToDate` dates), while the
/// Client wraps its snapshot in a versioned envelope with `.iso8601` dates.
/// These tests pin both shapes so a future "simplification" cannot quietly
/// reintroduce the mismatch.
final class WidgetSnapshotResolverTests: XCTestCase {

    private var directory: URL!
    private var resolver: WidgetSnapshotResolver!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("widget-resolver-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        resolver = WidgetSnapshotResolver(containerURL: directory)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        directory = nil
        resolver = nil
        super.tearDown()
    }

    // MARK: - Payload shapes

    private func writeLocal(_ snapshot: WidgetSnapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        try data.write(
            to: directory.appendingPathComponent(WidgetSnapshotResolver.localFileName),
            options: .atomic
        )
    }

    private func writeClient(_ snapshot: WidgetSnapshot) throws {
        let envelope = SnapshotEnvelope(schemaVersion: 2, snapshot: snapshot)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(envelope).write(
            to: directory.appendingPathComponent("widget-snapshot-v2.json"),
            options: .atomic
        )
    }

    private struct SnapshotEnvelope: Codable {
        let schemaVersion: Int
        let snapshot: WidgetSnapshot
    }

    private func snapshot(
        generatedAt: Date,
        totalSpentUsd: Double = 100
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            month: "2026-10",
            totalSpentUsd: totalSpentUsd,
            totalBudgetUsd: 500,
            projectedEomUsd: 400,
            percentUsed: 0.2,
            overBudget: false,
            warning: false,
            topMeters: []
        )
    }

    // MARK: - The regression itself

    /// The exact owner-reported state: only the Local app has written, and the
    /// widget must still find it. Before the resolver this returned nil.
    func testReadsLocalPayloadWhenOnlyLocalHasWritten() throws {
        let stamp = Date(timeIntervalSince1970: 1_780_000_000)
        try writeLocal(snapshot(generatedAt: stamp, totalSpentUsd: 42))

        let read = resolver.readDetailed()

        XCTAssertEqual(read.diagnostics.source, .local)
        XCTAssertEqual(read.diagnostics.containerAvailable, true)
        XCTAssertEqual(read.snapshot?.totalSpentUsd, 42)
    }

    /// A Client-only install must keep working exactly as before.
    func testReadsClientPayloadWhenOnlyClientHasWritten() throws {
        let stamp = Date(timeIntervalSince1970: 1_780_000_000)
        try writeClient(snapshot(generatedAt: stamp, totalSpentUsd: 7))

        let read = resolver.readDetailed()

        XCTAssertEqual(read.diagnostics.source, .client)
        XCTAssertEqual(read.snapshot?.totalSpentUsd, 7)
    }

    /// With both apps installed, the newer payload wins — otherwise whichever
    /// app refreshed last would be silently ignored.
    func testNewerPayloadWinsWhenBothAppsHaveWritten() throws {
        let base = Date(timeIntervalSince1970: 1_780_000_000)
        try writeClient(snapshot(generatedAt: base, totalSpentUsd: 1))
        try writeLocal(snapshot(generatedAt: base.addingTimeInterval(60), totalSpentUsd: 2))
        XCTAssertEqual(resolver.readDetailed().diagnostics.source, .local)

        // Reverse the ages: the Client is now the fresher writer.
        try writeClient(snapshot(generatedAt: base.addingTimeInterval(120), totalSpentUsd: 3))
        let read = resolver.readDetailed()
        XCTAssertEqual(read.diagnostics.source, .client)
        XCTAssertEqual(read.snapshot?.totalSpentUsd, 3)
    }

    /// Neither app has written: stay empty and say so, rather than inventing zeros.
    func testEmptyContainerReportsNoSource() {
        let read = resolver.readDetailed()

        XCTAssertNil(read.snapshot)
        XCTAssertNil(read.diagnostics.source)
        XCTAssertFalse(read.diagnostics.isUsable)
        XCTAssertTrue(read.diagnostics.containerAvailable)
    }

    /// A corrupt Local payload must not take the Client's good one down with it.
    func testCorruptLocalFileFallsBackToClient() throws {
        let stamp = Date(timeIntervalSince1970: 1_780_000_000)
        try writeClient(snapshot(generatedAt: stamp, totalSpentUsd: 9))
        try Data("not-json".utf8).write(
            to: directory.appendingPathComponent(WidgetSnapshotResolver.localFileName),
            options: .atomic
        )

        let read = resolver.readDetailed()

        XCTAssertEqual(read.snapshot?.totalSpentUsd, 9)
        XCTAssertEqual(read.diagnostics.source, .client)
        XCTAssertTrue(read.diagnostics.localFileRejected)
    }

    /// The Local writer's date encoding is `deferredToDate`, not `.iso8601`.
    /// If this ever decodes to a wrong-but-plausible date, the age maths and
    /// the stale badge would quietly lie, so assert the round trip exactly.
    func testLocalPayloadDatesRoundTripExactly() throws {
        let stamp = Date(timeIntervalSince1970: 1_780_123_456)
        try writeLocal(snapshot(generatedAt: stamp))

        let read = resolver.readDetailed()

        XCTAssertEqual(
            read.snapshot?.generatedAt.timeIntervalSince1970 ?? 0,
            stamp.timeIntervalSince1970,
            accuracy: 0.001
        )
    }

    /// A missing app group is the one failure no amount of tapping fixes, so
    /// the diagnostics must say so rather than reporting an ordinary empty state.
    func testMissingContainerIsReportedAsUnavailable() throws {
        try writeLocal(snapshot(generatedAt: Date()))

        let unavailable = WidgetSnapshotResolver(containerURL: nil).readDetailed()

        XCTAssertFalse(unavailable.diagnostics.containerAvailable)
        XCTAssertFalse(unavailable.diagnostics.isUsable)
        XCTAssertNil(unavailable.snapshot)
        XCTAssertTrue(WidgetSnapshotResolver(containerURL: nil).isAppGroupUnavailable)
    }

    /// Rejecting a snapshot because of its timestamp would leave a widget that
    /// can never recover, so assert the reader tolerates the Local shape.
    func testLocalPayloadWithQuotaSectionRoundTrips() throws {
        let stamp = Date(timeIntervalSince1970: 1_780_000_000)
        var base = snapshot(generatedAt: stamp)
        base.quotas = WidgetSnapshot.QuotaSection(
            generatedAt: stamp,
            windows: [
                WidgetSnapshot.QuotaSection.Window(
                    id: "anthropic-5h",
                    providerId: "anthropic",
                    providerLabel: "Anthropic",
                    label: "5h",
                    remainingFraction: 0.42
                )
            ]
        )
        try writeLocal(base)

        let read = resolver.readDetailed()

        XCTAssertEqual(read.snapshot?.quotas?.windows.first?.providerId, "anthropic")
        XCTAssertEqual(read.snapshot?.quotas?.windows.first?.remainingFraction ?? 0, 0.42, accuracy: 0.0001)
    }
}
