import XCTest
@testable import Settings
@testable import AppCore
@testable import Networking
import Models

@MainActor
final class SettingsFeatureTests: XCTestCase {

    func testLiveVerifierUsesCookieFreeEphemeralSession() {
        let session = LiveTokenVerifier.makeCookieFreeSession()

        XCTAssertNil(session.configuration.httpCookieStorage)
        XCTAssertFalse(session.configuration.httpShouldSetCookies)
        XCTAssertEqual(session.configuration.httpCookieAcceptPolicy, .never)
    }

    private func makeEnv(token: String? = nil, host: String = "") -> AppEnvironment {
        let defaults = UserDefaults(suiteName: "test.settings.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.baseHost = host
        return AppEnvironment(settings: settings, tokenStore: InMemoryTokenStore(token: token))
    }

    // MARK: Token connection

    func testConnectPersistsTokenAfterSuccessfulVerification() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        vm.tokenInput = "  good-token  "

        await vm.connect()

        XCTAssertEqual(vm.phase, .verified)
        XCTAssertTrue(env.hasToken)
        XCTAssertEqual(vm.tokenInput, "", "The field is cleared once the token is safely stored.")
    }

    func testConnectRejectsBadTokenWithoutStoringIt() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.failure(.unauthorized)))
        vm.bind(to: env)
        vm.tokenInput = "wrong"

        await vm.connect()

        XCTAssertEqual(vm.phase, .failed(.unauthorized))
        XCTAssertFalse(env.hasToken, "A rejected token must never reach the Keychain.")
    }

    func testServerErrorDoesNotPersistUnverifiedToken() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.failure(.serverNotConfigured)))
        vm.bind(to: env)
        vm.tokenInput = "probably-fine"

        await vm.connect()
        XCTAssertEqual(vm.phase, .failed(.serverNotConfigured))
        XCTAssertFalse(env.hasToken)
    }

    func testConnectWithEmptyTokenFailsFast() async {
        let env = makeEnv()
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        vm.tokenInput = "   "

        await vm.connect()

        XCTAssertEqual(vm.phase, .failed(.missingToken))
        XCTAssertFalse(env.hasToken)
    }

    func testRemoveTokenClearsCredentialAndResets() {
        let env = makeEnv(token: "existing")
        let vm = SettingsViewModel(verifier: StubTokenVerifier(.success(())))
        vm.bind(to: env)
        XCTAssertEqual(vm.phase, .configured, "A stored token is configured but not live-verified after relaunch.")

        vm.removeToken()

        XCTAssertFalse(env.hasToken)
        XCTAssertEqual(vm.phase, .idle)
    }

    // MARK: Host handling

    func testHostValidationAndResolvedDisplay() {
        let env = makeEnv()
        let vm = SettingsViewModel()
        vm.bind(to: env)

        XCTAssertTrue(vm.isHostValid, "Empty host is valid (means the production default).")
        XCTAssertEqual(vm.resolvedHostDisplay, "usage.jays.services")

        vm.hostInput = "staging.example.com"
        XCTAssertTrue(vm.isHostValid)
        XCTAssertEqual(vm.resolvedHostDisplay, "staging.example.com")
        XCTAssertTrue(vm.hostChanged)

        vm.hostInput = "http://"
        XCTAssertFalse(vm.isHostValid, "A URL with no host is rejected.")
    }

    func testApplyHostChangePersistsAndReconfigures() {
        let env = makeEnv(token: "tok")
        let vm = SettingsViewModel()
        vm.bind(to: env)
        vm.hostInput = "staging.example.com"
        XCTAssertTrue(vm.hostChanged)

        vm.applyHostChange()

        XCTAssertEqual(env.settings.baseHost, "staging.example.com")
        XCTAssertFalse(vm.hostChanged, "Once applied, the field matches the persisted host.")
    }

    // MARK: Formatting

    func testUptimeFormatting() {
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 273_600), "3d 4h")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 3_660), "1h 1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 90), "1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 30), "30s")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 0), "just started")
    }

    // MARK: Server status

    func testSnapshotRollupsAndDependencyRows() {
        let degraded = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: false,
                status: "degraded",
                checks: .init(database: .init(ok: true), scheduler: .init(ok: false))
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(degraded.overallStatus, .warning)
        XCTAssertEqual(degraded.overallLabel, "Degraded")
        XCTAssertEqual(degraded.dependencyChecks.count, 2)

        let down = ServerStatusSnapshot(
            health: .init(ok: false, status: "fail"),
            readiness: nil,
            fetchedAt: Date()
        )
        XCTAssertEqual(down.overallStatus, .danger)
        XCTAssertEqual(down.overallLabel, "Offline")
        XCTAssertTrue(down.dependencyChecks.isEmpty)
    }

    func testServerStatusStoreLoadsViaProbe() async {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok", version: "1.0.0"),
            readiness: nil,
            fetchedAt: Date()
        )
        let store = ServerStatusStore(probe: { _ in snapshot })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.value, snapshot)
    }

    func testServerStatusStoreSurfacesTypedError() async {
        let store = ServerStatusStore(probe: { _ in throw APIError.offline })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.error, .offline)
    }
}
