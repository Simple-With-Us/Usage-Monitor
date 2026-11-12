import XCTest
@testable import DesignSystem

final class TabBarScrollClearanceTests: XCTestCase {
    /// The bar is anchored and reserves its own height via `safeAreaInset`
    /// (2026-08-31 redesign); the clearance only clears the bottom
    /// scroll-edge fade.  It must stay positive but well under the old
    /// floating-capsule 96pt — stacked large clearances are what blanked
    /// two-thirds of the Platforms tab.
    func testClearanceOnlyClearsTheScrollEdgeFade() {
        XCTAssertGreaterThanOrEqual(Theme.Spacing.tabBarClearance, 16)
        XCTAssertLessThanOrEqual(Theme.Spacing.tabBarClearance, 48)
    }
}
