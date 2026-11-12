import XCTest
@testable import AppLock

// ---------------------------------------------------------------------------
// AppLock-lane unit tests: the lock/unlock state machine, driven by a stub
// authenticator so nothing touches LocalAuthentication or a device.
//
// ⚠️ INTEGRATION NOTE (for the Assemble agent): the `UsageMonitorKitTests`
// target does NOT yet depend on the `AppLock` product, so `@testable import
// AppLock` will not resolve until `AppLock` is added to that test target's
// dependencies in `Package.swift`:
//
//     .testTarget(
//         name: "UsageMonitorKitTests",
//         dependencies: ["Models", "Networking", "AppCore", "DesignSystem", "AppLock"]
//     )
// (append "AppLock" alongside whatever other lanes have added.)
// ---------------------------------------------------------------------------

/// Scriptable authenticator: hands back a queued result per `evaluate` call and
/// records how many prompts were presented.
private final class StubAuthenticator: AppLockAuthenticator, @unchecked Sendable {
    var availabilityValue: AppLockAvailability
    private var results: [Result<Void, AppLockError>]
    private(set) var evaluateCount = 0

    init(
        availability: AppLockAvailability = .available(.faceID),
        results: [Result<Void, AppLockError>]
    ) {
        self.availabilityValue = availability
        self.results = results
    }

    func availability() -> AppLockAvailability { availabilityValue }

    func evaluate(reason: String) async -> Result<Void, AppLockError> {
        evaluateCount += 1
        return results.isEmpty ? .success(()) : results.removeFirst()
    }
}

@MainActor
final class AppLockControllerTests: XCTestCase {

    // Starts locked (fail-closed) so content is never shown pre-auth.
    func testStartsLockedByDefault() {
        let controller = AppLockController(authenticator: StubAuthenticator(results: []))
        XCTAssertEqual(controller.phase, .locked)
    }

    // Enabled + successful biometrics -> unlocked, exactly one prompt.
    func testUnlockIfNeededSucceeds() async {
        let stub = StubAuthenticator(results: [.success(())])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)

        XCTAssertEqual(controller.phase, .unlocked)
        XCTAssertEqual(stub.evaluateCount, 1)
    }

    // Failure surfaces the typed error and stays locked (failed) for retry.
    func testUnlockIfNeededFailsKeepsLocked() async {
        let stub = StubAuthenticator(results: [.failure(.failed)])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)

        XCTAssertEqual(controller.phase, .failed(.failed))
        XCTAssertFalse(controller.phase.isUnlocked)
    }

    // Disabled toggle => pass-through: no prompt, immediately unlocked.
    func testDisabledUnlocksWithoutPrompting() async {
        let stub = StubAuthenticator(results: [.failure(.failed)])
        let controller = AppLockController(authenticator: stub)

        controller.syncEnabled(false)
        await controller.unlockIfNeeded(enabled: false)

        XCTAssertEqual(controller.phase, .unlocked)
        XCTAssertEqual(stub.evaluateCount, 0)
    }

    // A `.unavailable` device (no passcode/biometrics) fails OPEN, not closed.
    func testUnavailableFailsOpen() async {
        let stub = StubAuthenticator(results: [.failure(.unavailable)])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)

        XCTAssertEqual(controller.phase, .unlocked)
    }

    // After a cancel, auto-resume must NOT re-prompt: only `.locked` auto-fires,
    // a `.failed` state waits for an explicit retry(). Guards the prompt loop.
    func testFailedStateDoesNotAutoReprompt() async {
        let stub = StubAuthenticator(results: [.failure(.canceled), .success(())])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)   // -> .failed(.canceled)
        XCTAssertEqual(controller.phase, .failed(.canceled))

        // Simulate a foreground event; must be a no-op from `.failed`.
        await controller.unlockIfNeeded(enabled: true)
        XCTAssertEqual(stub.evaluateCount, 1)
        XCTAssertEqual(controller.phase, .failed(.canceled))

        // Explicit user tap retries and now succeeds.
        await controller.retry()
        XCTAssertEqual(controller.phase, .unlocked)
        XCTAssertEqual(stub.evaluateCount, 2)
    }

    // Backgrounding an unlocked, enabled app re-locks it so resume re-prompts.
    func testLockOnBackgroundRelocks() async {
        let stub = StubAuthenticator(results: [.success(()), .success(())])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)
        XCTAssertEqual(controller.phase, .unlocked)

        controller.lock(enabled: true)
        XCTAssertEqual(controller.phase, .locked)

        await controller.unlockIfNeeded(enabled: true)
        XCTAssertEqual(controller.phase, .unlocked)
        XCTAssertEqual(stub.evaluateCount, 2)
    }

    // Backgrounding when the feature is disabled must not lock the app.
    func testLockNoOpWhenDisabled() async {
        let controller = AppLockController(
            authenticator: StubAuthenticator(results: []),
            initialPhase: .unlocked
        )
        controller.lock(enabled: false)
        XCTAssertEqual(controller.phase, .unlocked)
    }

    // Backgrounding a `.failed` app resets it to a clean `.locked` for resume.
    func testLockResetsFailedToLocked() async {
        let stub = StubAuthenticator(results: [.failure(.failed)])
        let controller = AppLockController(authenticator: stub)

        await controller.unlockIfNeeded(enabled: true)
        XCTAssertEqual(controller.phase, .failed(.failed))

        controller.lock(enabled: true)
        XCTAssertEqual(controller.phase, .locked)
    }
}
