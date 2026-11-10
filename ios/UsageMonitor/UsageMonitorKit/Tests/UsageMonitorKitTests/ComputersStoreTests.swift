import XCTest
@testable import Computers
@testable import Models
@testable import Networking

@MainActor
final class ComputersStoreTests: XCTestCase {
    func testInitialFailureSurfacesAsFailedState() async {
        let store = ComputersStore { _ in throw APIError.unauthorized }
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore(token: "token"))

        await store.load(using: client)

        XCTAssertNil(store.state.value)
        XCTAssertEqual(store.state.error, .unauthorized)
        XCTAssertNil(store.lastError)
    }

    func testRefreshFailurePreservesLoadedDataAndSetsLastError() async {
        var shouldFail = false
        let store = ComputersStore { _ in
            if shouldFail { throw APIError.unauthorized }
            return MacHealthResponse(
                ok: true,
                status: "online",
                lastHeartbeatAt: "2026-08-16T12:00:00.000Z",
                secondsSinceHeartbeat: 10,
                mac: nil
            )
        }
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore(token: "token"))

        await store.load(using: client)
        XCTAssertNotNil(store.state.value)
        XCTAssertNil(store.lastError)

        shouldFail = true
        await store.refresh(using: client)

        XCTAssertNotNil(store.state.value)
        XCTAssertEqual(store.lastError, .unauthorized)
    }

    func testComputersAuthCopyClarifiesMonitorNotMac() {
        XCTAssertEqual(APIError.unauthorized.computersTitle, "Monitor access rejected")
        XCTAssertTrue(APIError.unauthorized.computersMessage.contains("monitor"))
        XCTAssertTrue(APIError.missingToken.computersMessage.contains("Settings"))
    }
}
