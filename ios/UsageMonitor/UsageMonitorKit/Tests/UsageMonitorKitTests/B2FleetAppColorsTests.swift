import XCTest
import DesignSystem

final class B2FleetAppColorsTests: XCTestCase {
    func testOrderedAppIdsMatchesDonutListOrder() {
        let ordered = B2FleetAppColors.orderedAppIds(
            payloadIds: ["usage-monitor", "socratic-trade", "congress-trade"],
            extraIds: []
        )
        XCTAssertEqual(ordered, ["socratic-trade", "congress-trade", "usage-monitor"])
    }

    func testKnownAppColorsAreStable() {
        XCTAssertEqual(
            B2FleetAppColors.color(forAppId: "socratic-trade"),
            Theme.Colors.accent
        )
    }
}
