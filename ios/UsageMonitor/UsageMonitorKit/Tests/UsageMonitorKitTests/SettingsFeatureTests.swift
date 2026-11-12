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

    func testAboutFooterKeepsTwoSpacesAndNamesTheApp() {
        let footer = AppInfo.aboutFooter
        XCTAssertTrue(
            footer.contains(".  "),
            "About footer must use two spaces after the first sentence."
        )
        XCTAssertTrue(footer.contains(AppInfo.displayName))
        XCTAssertTrue(footer.contains("Data stays on your device"))
        XCTAssertFalse(footer.contains("glance. Data"))
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
}
