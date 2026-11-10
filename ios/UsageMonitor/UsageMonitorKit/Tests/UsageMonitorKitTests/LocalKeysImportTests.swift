import XCTest
import CryptoKit
@testable import LocalDataPlane
@testable import LocalAdapters
@testable import LocalSecrets
@testable import LocalStore

// ---------------------------------------------------------------------------
// Key-bundle importer tests.
//
// The PINNED CROSS-LANGUAGE TEST VECTOR below is embedded verbatim in both
// the Node generator's tests and here so the two implementations can never
// drift.  Never regenerate one side alone.  All values are fixtures —
// obviously fake, no realistic vendor key shapes.
// ---------------------------------------------------------------------------

final class LocalKeysImportTests: XCTestCase {
    private static let pinnedPassphrase = "correct-horse-test-vector"
    private static let pinnedEnvelope = #"{"format":"usage-monitor-local-keys","formatVersion":1,"kdf":"pbkdf2-hmac-sha256","iterations":210000,"salt":"dW0tbG9jYWwta2V5cy1maQ==","nonce":"Zml4dHVyZS1ub25j","ciphertext":"TOCQha75BDgHZXvA9wePn4oooAuBloZFcB/gXEorUslZfJEiLSZFZl03cGqtZOi+AnKP0RWmUT3TcFiJc0q/ub+flH/WyAl0k/MAI2UO1P1D1v7O0HplHiIOYWuorpYFwu8quG//VYrIHFzpZHInPUuS0zsOuMWg0c9xNEHLh6gPmu2PdurIMK+m09gJmmwLYauVGOqo+M1IfnXPdi1XjADqDxDuJqQ6wpbl+NREr69b3akWnPUE1KP/iEdm/AYguQtUxNQdrVK1lNfnJm5cl13PvAeeodTJx5UiuFVKVxhUZ3re+FnszcI4h6uY1CGm9C/SQ1+1XrAADAKm8KTJu3X4e09ADNKp0Q=="}"#

    private static var pinnedEnvelopeData: Data { Data(pinnedEnvelope.utf8) }

    // 1. The pinned vector decrypts to the pinned payload.
    func testPinnedVectorDecryptsToPinnedPayload() throws {
        let payload = try LocalKeysImportBuilder.decryptPayload(
            envelopeData: Self.pinnedEnvelopeData,
            passphrase: Self.pinnedPassphrase
        )
        XCTAssertEqual(payload.secrets.count, 2)
        XCTAssertEqual(payload.secrets[0].provider, "openrouter")
        XCTAssertEqual(payload.secrets[0].apiKey, "sk-or-fixture-not-real")
        XCTAssertNil(payload.secrets[0].teamId)
        XCTAssertEqual(payload.secrets[1].provider, "xai")
        XCTAssertEqual(payload.secrets[1].apiKey, "xai-fixture-not-real")
        XCTAssertEqual(payload.secrets[1].teamId, "team-fixture")
        XCTAssertNil(payload.configData)
        XCTAssertEqual(payload.malformedSecretRows, 0)
    }

    // 2. Wrong passphrase -> the typed error.
    func testWrongPassphraseThrowsTypedError() {
        XCTAssertThrowsError(
            try LocalKeysImportBuilder.decryptPayload(
                envelopeData: Self.pinnedEnvelopeData,
                passphrase: "incorrect-horse-test-vector"
            )
        ) { error in
            XCTAssertEqual(error as? LocalKeysImportError, .wrongPassphraseOrTampered)
        }
    }

    // 3. Tampered ciphertext (one flipped byte) -> error.
    func testTamperedCiphertextThrows() throws {
        var root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Self.pinnedEnvelopeData) as? [String: Any]
        )
        var ct = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(root["ciphertext"] as? String)))
        ct[10] ^= 0x01
        root["ciphertext"] = ct.base64EncodedString()
        let tampered = try JSONSerialization.data(withJSONObject: root)
        XCTAssertThrowsError(
            try LocalKeysImportBuilder.decryptPayload(
                envelopeData: tampered,
                passphrase: Self.pinnedPassphrase
            )
        ) { error in
            XCTAssertEqual(error as? LocalKeysImportError, .wrongPassphraseOrTampered)
        }
    }

    // 4. Iterations out of contract bounds -> rejected before any derivation.
    func testIterationBoundsRejected() throws {
        var root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Self.pinnedEnvelopeData) as? [String: Any]
        )
        root["iterations"] = 50_000
        let weak = try JSONSerialization.data(withJSONObject: root)
        XCTAssertThrowsError(
            try LocalKeysImportBuilder.decryptPayload(envelopeData: weak, passphrase: Self.pinnedPassphrase)
        ) { error in
            XCTAssertEqual(error as? LocalKeysImportError, .weakIterations(50_000))
        }

        root["iterations"] = 6_000_000
        let excessive = try JSONSerialization.data(withJSONObject: root)
        XCTAssertThrowsError(
            try LocalKeysImportBuilder.decryptPayload(envelopeData: excessive, passphrase: Self.pinnedPassphrase)
        ) { error in
            XCTAssertEqual(error as? LocalKeysImportError, .excessiveIterations(6_000_000))
        }
    }

    // 5. End-to-end apply into an in-memory store + secret stub, then re-import
    //    replaces without orphaning Keychain accounts.
    @MainActor
    func testEndToEndApplyThenReplace() async throws {
        let store = SQLiteLocalStore.inMemory()
        try await store.open()
        let secrets = InMemorySecretStore()
        let model = LocalAppModel(store: store, secrets: secrets)

        let first = try await LocalKeysImportBuilder.importBundle(
            data: Self.pinnedEnvelopeData,
            passphrase: Self.pinnedPassphrase,
            model: model
        )
        XCTAssertEqual(first.imported, 2)
        XCTAssertEqual(first.replaced, 0)
        XCTAssertEqual(first.skippedUnknown, 0)
        XCTAssertNil(first.configResult)

        let providers = try await store.listProviders()
        let openrouter = try XCTUnwrap(providers.first { $0.name == "openrouter" })
        let xai = try XCTUnwrap(providers.first { $0.name == "xai" })
        XCTAssertEqual(openrouter.adapterKind, "openrouter")
        XCTAssertEqual(xai.adapterKind, "xai")
        let orAccount = try XCTUnwrap(openrouter.keychainAccountId)
        let xaiAccount = try XCTUnwrap(xai.keychainAccountId)
        XCTAssertEqual(try secrets.load(accountId: orAccount)?.apiKey, "sk-or-fixture-not-real")
        let xaiCreds = try XCTUnwrap(try secrets.load(accountId: xaiAccount))
        XCTAssertEqual(xaiCreds.apiKey, "xai-fixture-not-real")
        XCTAssertEqual(xaiCreds.teamId, "team-fixture")
        XCTAssertEqual(secrets.accountCount, 2)

        // Re-import: counted as replaced, still exactly one Keychain account
        // per provider — the superseded account id is deleted.
        let second = try await LocalKeysImportBuilder.importBundle(
            data: Self.pinnedEnvelopeData,
            passphrase: Self.pinnedPassphrase,
            model: model
        )
        XCTAssertEqual(second.imported, 0)
        XCTAssertEqual(second.replaced, 2)
        XCTAssertEqual(second.skippedUnknown, 0)
        XCTAssertEqual(secrets.accountCount, 2)

        let after = try await store.listProviders()
        let orAfter = try XCTUnwrap(after.first { $0.name == "openrouter" }?.keychainAccountId)
        XCTAssertNotEqual(orAfter, orAccount)
        XCTAssertEqual(try secrets.load(accountId: orAfter)?.apiKey, "sk-or-fixture-not-real")
        XCTAssertNil(try secrets.load(accountId: orAccount))
        let xaiAfter = try XCTUnwrap(after.first { $0.name == "xai" }?.keychainAccountId)
        XCTAssertNotEqual(xaiAfter, xaiAccount)
        XCTAssertEqual(try secrets.load(accountId: xaiAfter)?.teamId, "team-fixture")
        XCTAssertNil(try secrets.load(accountId: xaiAccount))
    }

    // 6. Unknown provider name -> skippedUnknown; everything else (secrets and
    //    embedded config) still imports.
    @MainActor
    func testUnknownProviderSkippedOthersStillImport() async throws {
        let payload: [String: Any] = [
            "format": "usage-monitor-local-keys-payload",
            "formatVersion": 1,
            "createdAt": "2026-08-12T00:00:00.000Z",
            "secrets": [
                ["provider": "definitely-not-a-catalog-provider", "apiKey": "fake-fixture-key"],
                ["provider": "openrouter", "apiKey": "sk-or-fixture-not-real"],
            ],
            "config": [
                "format": "usage-monitor-local-export",
                "formatVersion": 1,
                "providers": [
                    [
                        "name": "config-only-provider",
                        "displayName": "Config Only",
                        "adapterKind": "subscription_only",
                    ],
                ],
            ],
        ]
        let envelope = try Self.makeEnvelope(payload: payload, passphrase: "unit-test-passphrase")

        let store = SQLiteLocalStore.inMemory()
        try await store.open()
        let secrets = InMemorySecretStore()
        let model = LocalAppModel(store: store, secrets: secrets)

        let result = try await LocalKeysImportBuilder.importBundle(
            data: envelope,
            passphrase: "unit-test-passphrase",
            model: model
        )
        XCTAssertEqual(result.skippedUnknown, 1)
        XCTAssertEqual(result.imported, 1)
        XCTAssertEqual(result.replaced, 0)
        XCTAssertEqual(result.configResult?.providers, 1)

        let providers = try await store.listProviders()
        XCTAssertNotNil(providers.first { $0.name == "openrouter" }?.keychainAccountId)
        XCTAssertNotNil(providers.first { $0.name == "config-only-provider" })
        XCTAssertNil(providers.first { $0.name == "definitely-not-a-catalog-provider" })
        XCTAssertEqual(secrets.accountCount, 1)
    }

    // MARK: - Helpers

    /// Build an envelope in-process (CryptoKit seal) for cases the pinned
    /// vector cannot cover.  Iterations sit at the contract minimum so tests
    /// stay fast.
    private static func makeEnvelope(payload: [String: Any], passphrase: String) throws -> Data {
        let iterations = LocalKeysImportBuilder.minIterations
        let salt = Data("unit-test-salt-0".utf8)
        let nonce = Data("unit-nonce12".utf8)
        precondition(salt.count == 16 && nonce.count == 12)
        let key = try LocalKeysImportBuilder.deriveKey(
            passphrase: passphrase,
            salt: salt,
            iterations: iterations
        )
        let plaintext = try JSONSerialization.data(withJSONObject: payload)
        let box = try AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(data: nonce))
        let envelope: [String: Any] = [
            "format": "usage-monitor-local-keys",
            "formatVersion": 1,
            "kdf": "pbkdf2-hmac-sha256",
            "iterations": iterations,
            "salt": salt.base64EncodedString(),
            "nonce": nonce.base64EncodedString(),
            "ciphertext": (box.ciphertext + box.tag).base64EncodedString(),
        ]
        return try JSONSerialization.data(withJSONObject: envelope)
    }
}

/// In-memory ProviderSecretStoring stub — never touches the real Keychain.
private final class InMemorySecretStore: ProviderSecretStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: ProviderCredentials] = [:]

    func save(accountId: String, credentials: ProviderCredentials) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[accountId] = credentials
    }

    func load(accountId: String) throws -> ProviderCredentials? {
        lock.lock()
        defer { lock.unlock() }
        return storage[accountId]
    }

    func delete(accountId: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: accountId)
    }

    var accountCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage.count
    }
}
