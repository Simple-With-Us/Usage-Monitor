import Foundation
import XCTest
@testable import QuotaCore

final class BoundedQuotaProcessTests: XCTestCase {
    func testCapturesOutputWithoutAShell() async throws {
        let data = try await BoundedQuotaProcess().run(path: "/usr/bin/printf", arguments: ["quota-data"], home: temporaryHome)
        XCTAssertEqual(String(data: data, encoding: .utf8), "quota-data")
    }

    func testRejectsOutputBeyondTheLimit() async {
        do {
            _ = try await BoundedQuotaProcess().run(path: "/usr/bin/yes", arguments: [], home: temporaryHome, maxBytes: 4096)
            XCTFail("Unbounded output was accepted")
        } catch {}
    }

    func testTimeoutTerminatesTheOwnedHelper() async {
        do {
            _ = try await BoundedQuotaProcess().run(path: "/bin/sleep", arguments: ["30"], home: temporaryHome, timeout: 0.1)
            XCTFail("A slow helper escaped its timeout")
        } catch {}
    }

    func testCancellationStopsTheOwnedHelper() async {
        let task = Task {
            try await BoundedQuotaProcess().run(path: "/bin/sleep", arguments: ["30"], home: temporaryHome)
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Cancelled helper succeeded") }
        catch is CancellationError {}
        catch { XCTFail("Expected cancellation") }
    }

    private var temporaryHome: URL { FileManager.default.temporaryDirectory }
}
