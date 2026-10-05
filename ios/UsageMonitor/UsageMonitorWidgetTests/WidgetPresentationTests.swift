import XCTest
import DesignSystem
import WidgetShared

// NOTE: `WidgetPresentation` is a pure, view-free helper compiled from
// `UsageMonitorWidget/WidgetPresentation.swift`. This test target compiles that
// single file directly (see project.yml `UsageMonitorWidgetTests` sources) so
// the mapping/derivation logic is exercised without a WidgetKit host.
final class WidgetPresentationTests: XCTestCase {

    // MARK: - Raw status string -> SemanticStatus

    func testSemanticStatusMapsKnownRawValues() {
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "ok"), .ok)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "warning"), .warning)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "exceeded"), .danger)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "unconfigured"), .neutral)
    }

    func testSemanticStatusDegradesUnknownRawValueToNeutral() {
        // Schema drift must never crash or mis-alarm.
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: "totally-new"), .neutral)
        XCTAssertEqual(WidgetPresentation.semanticStatus(forRawStatus: ""), .neutral)
    }

    // MARK: - Fraction

    func testFractionComputesSpentOverBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 200), 0.25, accuracy: 0.0001)
    }

    func testFractionIsZeroWithoutBudget() {
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: nil), 0)
        XCTAssertEqual(WidgetPresentation.fraction(spent: 50, budget: 0), 0)
    }

    // MARK: - Overall status / label from snapshot flags

    func testOverallStatusPrioritisesOverBudget() {
        let s = makeSnapshot(overBudget: true, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .danger)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Over budget")
    }

    func testOverallStatusWarning() {
        let s = makeSnapshot(overBudget: false, warning: true, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .warning)
        XCTAssertEqual(WidgetPresentation.overallLabel(for: s), "Approaching")
    }

    func testOverallStatusOkWhenBudgetedAndOnTrack() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 900)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .ok)
        XCTAssertNil(WidgetPresentation.overallLabel(for: s))
    }

    func testOverallStatusNeutralWhenNoBudget() {
        let s = makeSnapshot(overBudget: false, warning: false, totalBudget: 0)
        XCTAssertEqual(WidgetPresentation.overallStatus(for: s), .neutral)
    }

    // MARK: - Detail / caption strings

    func testMeterDetailDropsDenominatorWithoutBudget() {
        XCTAssertFalse(WidgetPresentation.meterDetail(spent: 42, budget: nil).contains("/"))
        XCTAssertTrue(WidgetPresentation.meterDetail(spent: 42, budget: 100).contains("/"))
    }

    func testBudgetCaptionNilWithoutBudget() {
        XCTAssertNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 0)))
        XCTAssertNotNil(WidgetPresentation.budgetCaption(for: makeSnapshot(overBudget: false, warning: false, totalBudget: 900)))
    }

    // MARK: - Staleness caption

    func testShowsUpdatedAtForRealSnapshot() {
        XCTAssertTrue(WidgetPresentation.showsUpdatedAt(
            for: makeSnapshot(overBudget: false, warning: false, totalBudget: 900)
        ))
        XCTAssertTrue(WidgetPresentation.showsUpdatedAt(for: .placeholder))
    }

    func testHidesUpdatedAtForEmptySnapshot() {
        // The empty sentinel must never render "updated 56 years ago".
        XCTAssertFalse(WidgetPresentation.showsUpdatedAt(for: .empty))
    }

    func testIsStaleWhenOlderThanThreshold() {
        let now = Date(timeIntervalSince1970: 1_720_003_600) // +1h
        let fresh = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-30 * 60)
        )
        let stale = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-2 * 60 * 60)
        )
        XCTAssertFalse(WidgetPresentation.isStale(for: fresh, asOf: now))
        XCTAssertTrue(WidgetPresentation.isStale(for: stale, asOf: now))
        XCTAssertFalse(WidgetPresentation.isStale(for: .empty, asOf: now))
    }

    func testUpdatedCaptionMarksStale() {
        let now = Date(timeIntervalSince1970: 1_720_003_600)
        let stale = makeSnapshot(
            overBudget: false,
            warning: false,
            totalBudget: 900,
            generatedAt: now.addingTimeInterval(-3 * 60 * 60)
        )
        let caption = WidgetPresentation.updatedCaption(for: stale, asOf: now)
        // Age is never labeled "Stale" — refresh quietly; caption stays Updated.
        XCTAssertEqual(caption, "Updated 3 hr ago")
        XCTAssertNil(WidgetPresentation.updatedCaption(for: .empty, asOf: now))
    }

    func testDisplayAmountRedaction() {
        XCTAssertEqual(WidgetPresentation.displayAmount(42, redacted: true), "••••")
        XCTAssertFalse(WidgetPresentation.displayAmount(42, redacted: false).contains("•"))
        XCTAssertEqual(
            WidgetPresentation.displayMeterDetail(spent: 10, budget: 100, redacted: true),
            "••••"
        )
    }

    // MARK: - Unavailable message determinism

    /// `WidgetUnavailableContent` used to overwrite the caller's message with
    /// `WidgetSnapshotResolver.shared.isAppGroupUnavailable` on every init.
    /// That made the type non-deterministic — and the widget unit-test bundle
    /// is unhosted, so the shared resolver's app-group container is always
    /// nil there, latching the "Reinstall the app" message for every test.
    /// Tests can now force the condition via the explicit `appGroupUnavailable`
    /// parameter.
    func testUnavailableContentUsesCallerMessageWhenAppGroupIsAvailable() {
        let content = WidgetUnavailableContent(
            title: "Quotas",
            message: "Open the app to load plan quotas.",
            deepLink: URL(string: "usageclientmonitor://dashboard"),
            appGroupUnavailable: false
        )
        XCTAssertEqual(content.message, "Open the app to load plan quotas.")
    }

    func testUnavailableContentSubstitutesReinstallMessageWhenAppGroupIsUnavailable() {
        let content = WidgetUnavailableContent(
            title: "Quotas",
            message: "Open the app to load plan quotas.",
            deepLink: URL(string: "usageclientmonitor://dashboard"),
            appGroupUnavailable: true
        )
        XCTAssertEqual(
            content.message,
            "Widget storage is unavailable on this install. Reinstall the app to restore it."
        )
    }

    // MARK: - Focus selection (overall vs project)

    func testContentOverallUsesAccountTotalsAndProviderMeters() {
        let content = WidgetPresentation.content(from: .placeholder, focus: .overall)
        XCTAssertEqual(content.focus, .overall)
        XCTAssertEqual(content.title, "Overall")
        XCTAssertEqual(content.spentUsd, WidgetSnapshot.placeholder.totalSpentUsd)
        XCTAssertEqual(content.budgetUsd, WidgetSnapshot.placeholder.totalBudgetUsd)
        XCTAssertEqual(content.meters.count, 3)
        XCTAssertFalse(content.fellBackToOverall)
        XCTAssertEqual(content.deepLink?.absoluteString, "usageclientmonitor://dashboard")
    }

    func testContentProjectUsesProjectMeter() {
        let content = WidgetPresentation.content(
            from: .placeholder,
            focus: .project(id: "proj-ct")
        )
        XCTAssertEqual(content.focus, .project(id: "proj-ct"))
        XCTAssertEqual(content.title, "Congress.Trade")
        XCTAssertEqual(content.spentUsd, 180, accuracy: 0.001)
        XCTAssertEqual(content.budgetUsd, 400, accuracy: 0.001)
        XCTAssertTrue(content.meters.isEmpty)
        XCTAssertEqual(content.deepLink?.absoluteString, "usageclientmonitor://projects")
    }

    func testContentMissingProjectFallsBackToOverall() {
        let content = WidgetPresentation.content(
            from: .placeholder,
            focus: .project(id: "does-not-exist")
        )
        XCTAssertEqual(content.focus, .overall)
        XCTAssertTrue(content.fellBackToOverall)
        XCTAssertEqual(content.title, "Overall")
    }

    func testBudgetFocusParse() {
        XCTAssertEqual(WidgetBudgetFocus.parse(selectionId: nil), .overall)
        XCTAssertEqual(WidgetBudgetFocus.parse(selectionId: "overall"), .overall)
        XCTAssertEqual(WidgetBudgetFocus.parse(selectionId: "project:abc"), .project(id: "abc"))
        XCTAssertEqual(WidgetBudgetFocus.parse(selectionId: "legacy-id"), .project(id: "legacy-id"))
    }

    // MARK: - Helpers

    private func makeSnapshot(
        overBudget: Bool,
        warning: Bool,
        totalBudget: Double,
        generatedAt: Date = Date(timeIntervalSince1970: 1_720_000_000)
    ) -> WidgetSnapshot {
        WidgetSnapshot(
            generatedAt: generatedAt,
            month: "2026-07",
            totalSpentUsd: 428.16,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: 690.4,
            percentUsed: totalBudget > 0 ? 428.16 / totalBudget : nil,
            overBudget: overBudget,
            warning: warning,
            topMeters: [],
            projects: []
        )
    }
}

final class WidgetTopicPresentationTests: XCTestCase {
    func testBudgetTopicStillUsesExistingFocus() {
        let content = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .budget,
            budgetFocus: .project(id: "proj-ct"),
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .budget(let budget) = content else {
            return XCTFail("expected budget content")
        }
        XCTAssertEqual(budget.title, "Congress.Trade")
        XCTAssertEqual(budget.spentUsd, 180, accuracy: 0.001)
    }

    func testLlmUsesCachedProviderAndNotInventedCost() {
        let content = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .llmQuotas,
            budgetFocus: .overall,
            llmProviderId: "anthropic",
            serverFocus: .service
        )
        guard case .llm(let llm) = content else {
            return XCTFail("expected llm content")
        }
        XCTAssertEqual(llm.provider.name, "anthropic")
        XCTAssertEqual(WidgetTopicPresentation.llmDisplayCostUsd(for: llm.provider), 8.40)
        XCTAssertEqual(llm.deepLink?.absoluteString, "usageclientmonitor://dashboard")
    }

    func testLlmMissingSectionIsUnavailableNotZero() {
        let content = WidgetTopicPresentation.llmContent(
            from: .empty,
            providerId: nil,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.title, "LLM Quotas")
        XCTAssertEqual(unavailable.message, "Open the app to load LLM quotas.")
    }

    func testLlmUnknownProviderIsUnavailable() {
        let content = WidgetTopicPresentation.llmContent(
            from: .placeholder,
            providerId: "does-not-exist",
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.message, "That provider is not in the latest cache.")
    }

    func testLlmQuietProviderHasNoDisplayCost() {
        let voyage = WidgetSnapshot.placeholder.llm?.providers.first { $0.id == "voyage" }
        XCTAssertEqual(voyage?.quiet, true)
        XCTAssertNil(voyage.flatMap { WidgetTopicPresentation.llmDisplayCostUsd(for: $0) })
        XCTAssertEqual(
            WidgetTopicPresentation.llmTokenCaption(for: voyage!),
            "0 tok"
        )
    }

    func testServerServiceUsesCachedProbe() {
        let content = WidgetTopicPresentation.serverContent(from: .placeholder, focus: .service)
        guard case .server(let server) = content else {
            return XCTFail("expected server content")
        }
        XCTAssertEqual(server.title, "usage-monitor")
        XCTAssertEqual(
            WidgetTopicPresentation.serverOverallLabel(for: server.service!),
            "Operational"
        )
        XCTAssertEqual(server.deepLink?.absoluteString, "usageclientmonitor://serverStatus")
    }

    func testServerHostMissingIsUnavailable() {
        var snapshot = WidgetSnapshot.empty
        snapshot.servers = WidgetSnapshot.ServerSection(
            service: WidgetSnapshot.ServerSection.Service(
                generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
                name: "usage-monitor",
                ok: true,
                status: "live"
            )
        )
        let content = WidgetTopicPresentation.serverContent(
            from: snapshot,
            focus: .host,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable host")
        }
        XCTAssertEqual(unavailable.message, "Host metrics are not in the latest cache.")
    }

    func testServerMissingAppIsUnavailable() {
        let content = WidgetTopicPresentation.serverContent(
            from: .placeholder,
            focus: .app(id: "missing"),
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable app")
        }
        XCTAssertEqual(unavailable.message, "That app is not in the latest cache.")
    }

    func testServerFocusParse() {
        XCTAssertEqual(WidgetServerFocus.parse(selectionId: nil), .service)
        XCTAssertEqual(WidgetServerFocus.parse(selectionId: "server:host"), .host)
        XCTAssertEqual(WidgetServerFocus.parse(selectionId: "server:app:um"), .app(id: "um"))
    }

    func testTopicStaleUsesSectionTimestamp() {
        let now = Date(timeIntervalSince1970: 1_720_003_600)
        XCTAssertFalse(
            WidgetTopicPresentation.isStale(
                generatedAt: now.addingTimeInterval(-30 * 60),
                asOf: now
            )
        )
        XCTAssertTrue(
            WidgetTopicPresentation.isStale(
                generatedAt: now.addingTimeInterval(-2 * 60 * 60),
                asOf: now
            )
        )
        XCTAssertFalse(WidgetTopicPresentation.isStale(generatedAt: Date(timeIntervalSince1970: 0)))
        XCTAssertNil(
            WidgetTopicPresentation.updatedCaption(generatedAt: Date(timeIntervalSince1970: 0))
        )
    }

    func testEmptySnapshotDoesNotInventLlmOrServer() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = try encoder.encode(WidgetSnapshot.empty)
        let decoded = try decoder.decode(WidgetSnapshot.self, from: data)
        XCTAssertNil(decoded.llm)
        XCTAssertNil(decoded.servers)
        XCTAssertNil(decoded.mac)
        XCTAssertNil(decoded.alerts)
        XCTAssertEqual(decoded.spenders, [])
        XCTAssertEqual(decoded, .empty)
    }

    func testMacMissingSectionIsUnavailableNotZero() {
        let content = WidgetTopicPresentation.macContent(
            from: .empty,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.title, "Mac")
        XCTAssertEqual(unavailable.message, "Open the app to load Mac stats.")
        XCTAssertEqual(unavailable.deepLink?.absoluteString, "usageclientmonitor://computers")
    }

    func testMacNotReportedIsUnavailable() {
        var snapshot = WidgetSnapshot.empty
        snapshot.mac = WidgetSnapshot.MacSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            ok: false,
            status: "offline",
            reported: false
        )
        let content = WidgetTopicPresentation.macContent(
            from: snapshot,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.message, "The Mac has not reported yet.")
    }

    func testMacPlaceholderUsesCachedPercents() {
        let content = WidgetTopicPresentation.macContent(from: .placeholder)
        guard case .mac(let mac) = content else {
            return XCTFail("expected mac content")
        }
        XCTAssertEqual(mac.section.cpuUsagePct, 24)
        XCTAssertEqual(WidgetTopicPresentation.macLabel(mac.section), "Online")
        XCTAssertEqual(mac.deepLink?.absoluteString, "usageclientmonitor://computers")
    }

    func testMacOfflineIsStaleEvenWhenJustCached() {
        let now = Date(timeIntervalSince1970: 1_720_000_000)
        let section = WidgetSnapshot.MacSection(
            generatedAt: now,
            ok: false,
            status: "offline",
            reported: true,
            hostname: "jays-macbook-pro",
            cpuUsagePct: 10,
            lastHeartbeatAt: now
        )
        XCTAssertTrue(WidgetTopicPresentation.macIsStale(section, asOf: now))
        XCTAssertEqual(WidgetTopicPresentation.macLabel(section), "Offline")
        XCTAssertEqual(WidgetTopicPresentation.macStatus(section), .danger)
    }

    func testAlertsMissingSectionIsUnavailable() {
        let content = WidgetTopicPresentation.alertsContent(
            from: .empty,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.message, "Open the app to load alerts.")
        XCTAssertEqual(unavailable.deepLink?.absoluteString, "usageclientmonitor://alerts")
    }

    func testAlertsCountAndLatestTitle() {
        let content = WidgetTopicPresentation.alertsContent(from: .placeholder)
        guard case .alerts(let alerts) = content else {
            return XCTFail("expected alerts content")
        }
        XCTAssertEqual(alerts.section.openCount, 2)
        XCTAssertEqual(alerts.section.needsAttentionCount, 2)
        XCTAssertEqual(alerts.section.latestTitle, "Budget exceeded")
        XCTAssertEqual(WidgetTopicPresentation.alertsHeadline(openCount: 2), "2 Open")
        XCTAssertEqual(
            WidgetTopicPresentation.alertsNeedsAttentionLabel(count: 2),
            "Needs Attention"
        )
    }

    func testAlertsAllClearHeadline() {
        var snapshot = WidgetSnapshot.empty
        snapshot.month = "2026-08"
        snapshot.generatedAt = Date(timeIntervalSince1970: 1_720_000_000)
        snapshot.alerts = WidgetSnapshot.AlertsSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            openCount: 0,
            needsAttentionCount: 0
        )
        let content = WidgetTopicPresentation.alertsContent(from: snapshot)
        guard case .alerts(let alerts) = content else {
            return XCTFail("expected alerts content")
        }
        XCTAssertEqual(WidgetTopicPresentation.alertsHeadline(openCount: alerts.section.openCount), "All Clear")
        XCTAssertNil(WidgetTopicPresentation.alertsNeedsAttentionLabel(count: 0))
    }

    func testProvidersMissingMonthIsUnavailable() {
        let content = WidgetTopicPresentation.providersContent(
            from: .empty,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.message, "Open the app to load providers.")
        XCTAssertEqual(unavailable.deepLink?.absoluteString, "usageclientmonitor://providers")
    }

    func testProvidersUsesSpendersNotUtilisationOrder() {
        let content = WidgetTopicPresentation.providersContent(from: .placeholder)
        guard case .providers(let providers) = content else {
            return XCTFail("expected providers content")
        }
        XCTAssertEqual(providers.meters.map(\.name), ["Anthropic", "OpenAI", "Voyage"])
        XCTAssertEqual(providers.deepLink?.absoluteString, "usageclientmonitor://providers")
    }

    /// Kodus review fix: `topicContent` forwarded the intent's default
    /// `.utilisation` sort into the Providers topic, inverting it from "top
    /// spenders" to "closest to budget".  The placeholder's spend and
    /// utilisation orders coincide, so this uses meters where they diverge:
    /// "Cheap" is 90% used but spent little, "Rich" spent the most at 20%.
    /// The default-configured Providers topic must rank by spend.
    func testTopicContentProvidersDefaultsToSpendRanking() {
        var snapshot = WidgetSnapshot.empty
        snapshot.month = "2026-08"
        snapshot.generatedAt = Date(timeIntervalSince1970: 1_720_000_000)
        snapshot.spenders = [
            WidgetSnapshot.Meter(id: "cheap", name: "Cheap", spentUsd: 45, budgetUsd: 50, percentUsed: 0.9, status: "warning", projectedEomUsd: nil),
            WidgetSnapshot.Meter(id: "rich", name: "Rich", spentUsd: 200, budgetUsd: 1000, percentUsed: 0.2, status: "ok", projectedEomUsd: nil),
        ]
        let content = WidgetTopicPresentation.topicContent(
            from: snapshot,
            topic: .providers,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .providers(let providers) = content else {
            return XCTFail("expected providers content")
        }
        XCTAssertEqual(providers.meters.map(\.name), ["Rich", "Cheap"])
    }

    /// The Providers topic's previous bug discarded an explicit "Closest to
    /// Budget" pick because `.utilisation` was indistinguishable from the
    /// shared intent default.  Providers now reads `providersSort`, which the
    /// intent defaults to `.spend`, so an explicit `.utilisation` (Closest to
    /// Budget) pick must survive.
    func testTopicContentProvidersHonoursExplicitUtilisation() {
        var snapshot = WidgetSnapshot.empty
        snapshot.month = "2026-08"
        snapshot.generatedAt = Date(timeIntervalSince1970: 1_720_000_000)
        snapshot.spenders = [
            WidgetSnapshot.Meter(id: "cheap", name: "Cheap", spentUsd: 45, budgetUsd: 50, percentUsed: 0.9, status: "warning", projectedEomUsd: nil),
            WidgetSnapshot.Meter(id: "rich", name: "Rich", spentUsd: 200, budgetUsd: 1000, percentUsed: 0.2, status: "ok", projectedEomUsd: nil),
        ]
        let content = WidgetTopicPresentation.topicContent(
            from: snapshot,
            topic: .providers,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service,
            providersSort: .utilisation
        )
        guard case .providers(let providers) = content else {
            return XCTFail("expected providers content")
        }
        XCTAssertEqual(providers.meters.map(\.name), ["Cheap", "Rich"])
    }

    func testProvidersEmptySpendIsUnavailableNotZero() {
        var snapshot = WidgetSnapshot.empty
        snapshot.month = "2026-08"
        snapshot.generatedAt = Date(timeIntervalSince1970: 1_720_000_000)
        let content = WidgetTopicPresentation.providersContent(
            from: snapshot,
            appGroupUnavailable: false
        )
        guard case .unavailable(let unavailable) = content else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(unavailable.message, "No provider spend in the latest cache.")
    }

    func testTopicContentMacAlertsProviders() {
        let mac = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .mac,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .mac = mac else { return XCTFail("expected mac") }

        let alerts = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .alerts,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .alerts = alerts else { return XCTFail("expected alerts") }

        let providers = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .providers,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .providers = providers else { return XCTFail("expected providers") }
    }

    // MARK: - Quotas topic

    private func quotaWindow(
        id: String = "anthropic-5h",
        provider: String = "anthropic",
        label: String = "5h",
        remaining: Double? = 0.5,
        exhausted: Bool = false,
        nearCap: Bool = false
    ) -> WidgetSnapshot.QuotaSection.Window {
        WidgetSnapshot.QuotaSection.Window(
            id: id,
            providerId: provider,
            providerLabel: provider.capitalized,
            label: label,
            remainingFraction: remaining,
            isExhausted: exhausted,
            isNearCap: nearCap
        )
    }

    private func snapshotWithQuotas(_ windows: [WidgetSnapshot.QuotaSection.Window]) -> WidgetSnapshot {
        var snapshot = WidgetSnapshot.placeholder
        snapshot.quotas = WidgetSnapshot.QuotaSection(
            generatedAt: Date(timeIntervalSince1970: 1_780_000_000),
            windows: windows
        )
        return snapshot
    }

    func testQuotaTopicRendersWindows() {
        let content = WidgetTopicPresentation.topicContent(
            from: snapshotWithQuotas([quotaWindow(), quotaWindow(id: "codex-5h", provider: "codex")]),
            topic: .quotas,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .quota(let quota) = content else { return XCTFail("expected quota") }
        XCTAssertEqual(quota.windows.count, 2)
    }

    /// Quotas' sort picker used to be a no-op because `topicContent` never
    /// threaded `sortOrder` into `quotaContent`.  Most-urgent-first is the
    /// default; verify it places the lowest remaining fraction first so the
    /// medium hero's `windows.first` is always the worst window.
    func testQuotaContentUtilisationSortsMostUrgentFirst() {
        let urgent = quotaWindow(id: "urgent", provider: "urgent", remaining: 0.1)
        let healthy = quotaWindow(id: "healthy", provider: "healthy", remaining: 0.9)
        let snapshot = snapshotWithQuotas([healthy, urgent])
        let content = WidgetTopicPresentation.quotaContent(from: snapshot, maxMeters: 5, sortOrder: .utilisation)
        guard case .quota(let quota) = content else { return XCTFail("expected quota") }
        XCTAssertEqual(quota.windows.map(\.id), ["urgent", "healthy"])
    }

    /// Quotas' name sort orders alphabetically, the same option Edit Widget
    /// exposes on the Quotas tile.
    func testQuotaContentSpendSortUsesAlphabeticalOrder() {
        let zebra = quotaWindow(id: "zebra", provider: "Zebra")
        let alpha = quotaWindow(id: "alpha", provider: "Alpha")
        let snapshot = snapshotWithQuotas([zebra, alpha])
        let content = WidgetTopicPresentation.quotaContent(from: snapshot, maxMeters: 5, sortOrder: .spend)
        guard case .quota(let quota) = content else { return XCTFail("expected quota") }
        XCTAssertEqual(quota.windows.map(\.id), ["alpha", "zebra"])
    }

    /// A window the server described but gave no number must read "Unknown",
    /// never a fabricated 0% — that is the whole point of the section.
    func testQuotaRemainingCaptionNeverInventsAPercent() {
        XCTAssertEqual(
            WidgetTopicPresentation.quotaRemainingCaption(quotaWindow(remaining: nil)),
            "Unknown"
        )
        XCTAssertEqual(
            WidgetTopicPresentation.quotaRemainingCaption(quotaWindow(remaining: nil, exhausted: true)),
            "Exhausted"
        )
        XCTAssertEqual(
            WidgetTopicPresentation.quotaRemainingCaption(quotaWindow(remaining: 0.125)),
            "13% left"
        )
    }

    func testQuotaStatusSeparatesExhaustedNearCapAndHealthy() {
        XCTAssertEqual(WidgetTopicPresentation.quotaStatus(quotaWindow(remaining: 0.8)), .ok)
        XCTAssertEqual(WidgetTopicPresentation.quotaStatus(quotaWindow(remaining: 0.15)), .warning)
        XCTAssertEqual(
            WidgetTopicPresentation.quotaStatus(quotaWindow(remaining: 0.15, exhausted: true)),
            .danger
        )
        // No number = unknown, not "all used up".
        XCTAssertEqual(WidgetTopicPresentation.quotaStatus(quotaWindow(remaining: nil)), .neutral)
    }

    func testQuotaFractionUsedIsInverseOfRemaining() {
        XCTAssertEqual(WidgetTopicPresentation.quotaFractionUsed(quotaWindow(remaining: 0.25)), 0.75, accuracy: 0.0001)
        XCTAssertEqual(WidgetTopicPresentation.quotaFractionUsed(quotaWindow(remaining: nil)), 0, accuracy: 0.0001)
    }

    /// `quotaWindowCaption` used to feed the future `resetAt` through the
    /// past-tense `relativeAge` helper.  `relativeAge` clamps to zero for any
    /// future date and returns "just now", so the row read "Resets in just
    /// now" for a positive countdown.  The fix formats the forward interval
    /// against `now` directly.
    func testQuotaWindowCaptionFormatsFutureReset() {
        let now = Date(timeIntervalSince1970: 1_720_000_000)
        let reset = now.addingTimeInterval(45 * 60)
        var window = quotaWindow()
        window.resetAt = reset
        XCTAssertEqual(
            WidgetTopicPresentation.quotaWindowCaption(window, asOf: now),
            "Resets in 45 min"
        )
    }

    /// An already-elapsed reset must not claim a countdown or quote a past
    /// "ago" phrase; it returns nil so the row simply has no reset caption.
    func testQuotaWindowCaptionReturnsNilForElapsedReset() {
        let now = Date(timeIntervalSince1970: 1_720_000_000)
        var window = quotaWindow()
        window.resetAt = now.addingTimeInterval(-3 * 60 * 60)
        XCTAssertNil(WidgetTopicPresentation.quotaWindowCaption(window, asOf: now))
    }

    /// "Resets in 1 min" must never round down to zero on a tiny-but-positive
    /// interval; the previous "just now" output was unreachable for a true
    /// future reset because `relativeAge` returned "" only at exact equality.
    func testQuotaWindowCaptionNeverRoundsDownToZero() {
        let now = Date(timeIntervalSince1970: 1_720_000_000)
        var window = quotaWindow()
        window.resetAt = now.addingTimeInterval(10)
        XCTAssertEqual(
            WidgetTopicPresentation.quotaWindowCaption(window, asOf: now),
            "Resets in 1 min"
        )
    }

    /// No `resetAt`: fall back to the cadence string the server attached
    /// (e.g. "5h" / "7d"), or nil if the server omitted that too.
    func testQuotaWindowCaptionFallsBackToCadence() {
        var window = quotaWindow()
        window.resetAt = nil
        window.window = "5h"
        XCTAssertEqual(WidgetTopicPresentation.quotaWindowCaption(window), "5h")
        window.window = nil
        XCTAssertNil(WidgetTopicPresentation.quotaWindowCaption(window))
    }

    func testQuotaTopicIsUnavailableWithoutCache() {
        let content = WidgetTopicPresentation.topicContent(
            from: .empty,
            topic: .quotas,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service,
            appGroupUnavailable: false
        )
        guard case .unavailable = content else { return XCTFail("expected unavailable") }
    }

    // MARK: - Projects topic

    func testProjectsTopicRendersEveryProject() {
        let content = WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .projects,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
        guard case .projects(let projects) = content else { return XCTFail("expected projects") }
        XCTAssertEqual(projects.projects.count, WidgetSnapshot.placeholder.projects.count)
    }

    func testProjectsTopicIsUnavailableWithoutProjects() {
        let content = WidgetTopicPresentation.topicContent(
            from: .empty,
            topic: .projects,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service,
            appGroupUnavailable: false
        )
        guard case .unavailable = content else { return XCTFail("expected unavailable") }
    }

    // MARK: - Sort order

    /// "Closest to budget" and "highest spend" are genuinely different lists;
    /// this is the reason the option exists, so pin both.
    func testSortOrderChangesRanking() {
        let meters = [
            WidgetSnapshot.Meter(
                id: "a", name: "A", spentUsd: 10, budgetUsd: 100,
                percentUsed: 0.10, status: "ok"
            ),
            WidgetSnapshot.Meter(
                id: "b", name: "B", spentUsd: 90, budgetUsd: 100,
                percentUsed: 0.90, status: "warning"
            )
        ]

        let byUtilisation = WidgetPresentation.rank(meters, by: .utilisation)
        XCTAssertEqual(byUtilisation.map(\.id), ["b", "a"])

        let bySpend = WidgetPresentation.rank(meters, by: .spend)
        XCTAssertEqual(bySpend.map(\.id), ["b", "a"])

        // A case where they disagree: cheap-but-nearly-spent vs rich-and-idle.
        let disputed = [
            WidgetSnapshot.Meter(
                id: "cheap", name: "Cheap", spentUsd: 5, budgetUsd: 10,
                percentUsed: 0.50, status: "warning"
            ),
            WidgetSnapshot.Meter(
                id: "rich", name: "Rich", spentUsd: 500, budgetUsd: 10_000,
                percentUsed: 0.05, status: "ok"
            )
        ]
        XCTAssertEqual(WidgetPresentation.rank(disputed, by: .utilisation).map(\.id), ["cheap", "rich"])
        XCTAssertEqual(WidgetPresentation.rank(disputed, by: .spend).map(\.id), ["rich", "cheap"])
    }

    /// A provider with no budget is "unknown utilisation", not 0%, so it must
    /// sort below every budgeted row rather than to the top of the list.
    func testSortByUtilisationSinksUnbudgetedRows() {
        let meters = [
            WidgetSnapshot.Meter(
                id: "nobudget", name: "No Budget", spentUsd: 500,
                budgetUsd: nil, percentUsed: nil, status: "unconfigured"
            ),
            WidgetSnapshot.Meter(
                id: "budgeted", name: "Budgeted", spentUsd: 5, budgetUsd: 100,
                percentUsed: 0.05, status: "ok"
            )
        ]
        XCTAssertEqual(
            WidgetPresentation.rank(meters, by: .utilisation).map(\.id),
            ["budgeted", "nobudget"]
        )
    }

    /// Equal rows must keep a stable order, or every refresh reshuffles the
    /// widget while the owner is looking at it.
    func testSortIsStableForEqualRows() {
        let meters = [
            WidgetSnapshot.Meter(
                id: "b", name: "Beta", spentUsd: 5, budgetUsd: 10,
                percentUsed: 0.5, status: "ok"
            ),
            WidgetSnapshot.Meter(
                id: "a", name: "Alpha", spentUsd: 5, budgetUsd: 10,
                percentUsed: 0.5, status: "ok"
            )
        ]
        XCTAssertEqual(
            WidgetPresentation.rank(meters, by: .utilisation).map(\.id),
            ["a", "b"]
        )
    }

    /// Row count is a real Edit Widget option, so it must actually truncate.
    func testRowCountTruncatesListTopics() {
        let snapshot = WidgetSnapshot.placeholder
        let many = WidgetTopicPresentation.topicContent(
            from: snapshot,
            topic: .projects,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service,
            maxMeters: 1
        )
        guard case .projects(let projects) = many else { return XCTFail("expected projects") }
        XCTAssertEqual(projects.projects.count, 1)
    }
}
