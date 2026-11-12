import Foundation
import CommonCrypto
import CryptoKit
import LocalStore
import LocalSecrets
import LocalAdapters

// ---------------------------------------------------------------------------
// Encrypted key-propagation bundle importer (.umkeys).
//
// Cross-language contract (format "usage-monitor-local-keys", v1):
//   key        = PBKDF2-HMAC-SHA256(passphrase, salt[16], iterations, 32 bytes)
//   ciphertext = AES-256-GCM(nonce[12], payload JSON) with 16-byte tag APPENDED
// The Node generator embeds the same pinned test vector as
// LocalKeysImportTests — never change one side alone.
//
// Secret safety: secret VALUES never appear in errors, logs, or messages —
// names and counts only.  Decrypted plaintext never outlives the call.
// ---------------------------------------------------------------------------

public struct LocalKeysImportResult: Sendable, Equatable {
    /// Credentials applied to providers that had none.
    public var imported: Int
    /// Credentials that replaced an existing Keychain credential.
    public var replaced: Int
    /// Secrets skipped: catalog-unknown provider names or malformed rows.
    public var skippedUnknown: Int
    /// Result of the embedded config import (merge mode), when present.
    public var configResult: LocalImportResult?

    public init(
        imported: Int = 0,
        replaced: Int = 0,
        skippedUnknown: Int = 0,
        configResult: LocalImportResult? = nil
    ) {
        self.imported = imported
        self.replaced = replaced
        self.skippedUnknown = skippedUnknown
        self.configResult = configResult
    }
}

/// Typed, user-presentable failures.  Never embeds payload bytes or secret
/// values — field names and counts only.
public enum LocalKeysImportError: Error, Equatable, LocalizedError {
    case notAKeyBundle
    case unsupportedVersion(Int)
    case unsupportedKdf
    case weakIterations(Int)
    case excessiveIterations(Int)
    case malformedField(String)
    case wrongPassphraseOrTampered
    case unreadablePayload

    public var errorDescription: String? {
        switch self {
        case .notAKeyBundle:
            return "That file is not a Usage Monitor key bundle."
        case .unsupportedVersion(let v):
            return "This bundle uses format version \(v), which this app does not support.  Update the app and try again."
        case .unsupportedKdf:
            return "This bundle uses an unsupported key derivation.  Update the app and try again."
        case .weakIterations:
            return "This bundle's key derivation is too weak to accept.  Regenerate the bundle with the current tool."
        case .excessiveIterations:
            return "This bundle's key derivation count is unreasonably high.  Regenerate the bundle with the current tool."
        case .malformedField(let name):
            return "The bundle field “\(name)” is malformed.  Regenerate the bundle."
        case .wrongPassphraseOrTampered:
            return "Wrong passphrase, or the file was changed after it was created.  Nothing was imported."
        case .unreadablePayload:
            return "The bundle decrypted but its contents are not readable.  Regenerate the bundle."
        }
    }
}

public enum LocalKeysImportBuilder {
    public static let envelopeFormat = "usage-monitor-local-keys"
    public static let payloadFormat = "usage-monitor-local-keys-payload"
    public static let formatVersion = 1
    /// Iteration bounds from the contract: honour the stored value but reject
    /// weak (<100k) and DoS (>5M) counts.
    public static let minIterations = 100_000
    public static let maxIterations = 5_000_000

    struct SecretEntry: Equatable {
        var provider: String
        var apiKey: String
        var teamId: String?
        var accountSid: String?
        var apiKeySid: String?
    }

    struct Payload {
        var secrets: [SecretEntry]
        var configData: Data?
        var malformedSecretRows: Int
    }

    // MARK: - Apply

    /// Decrypt and apply a key bundle.  Embedded config (if present) imports
    /// first through the existing LocalImportBuilder (merge mode), then each
    /// secret goes through the LocalAppModel connect path so validation,
    /// Keychain write, account linking, and adapter-kind resolution stay
    /// single-sourced.  Unknown provider names are counted, never fatal.
    @MainActor
    public static func importBundle(
        data: Data,
        passphrase: String,
        model: LocalAppModel
    ) async throws -> LocalKeysImportResult {
        let payload = try decryptPayload(envelopeData: data, passphrase: passphrase)
        var result = LocalKeysImportResult(skippedUnknown: payload.malformedSecretRows)
        if let configData = payload.configData {
            result.configResult = try await model.importPackage(data: configData, mode: .merge)
        }
        for secret in payload.secrets {
            guard let entry = LocalProviderCatalog.entry(name: secret.provider) else {
                result.skippedUnknown += 1
                continue
            }
            let replaced = try await model.connectImportedCredentials(
                entry: entry,
                apiKey: secret.apiKey,
                teamId: secret.teamId,
                accountSid: secret.accountSid,
                apiKeySid: secret.apiKeySid
            )
            if replaced {
                result.replaced += 1
            } else {
                result.imported += 1
            }
        }
        return result
    }

    // MARK: - Envelope decode + decrypt

    private struct Envelope: Decodable {
        let format: String
        let formatVersion: Int
        let kdf: String
        let iterations: Int
        let salt: String
        let nonce: String
        let ciphertext: String
    }

    /// Decode + validate the envelope, derive the key, decrypt, and parse the
    /// payload.  The plaintext stays local to this call — no caching, no
    /// logging, no error embedding.
    static func decryptPayload(envelopeData: Data, passphrase: String) throws -> Payload {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: envelopeData) else {
            throw LocalKeysImportError.notAKeyBundle
        }
        guard envelope.format == envelopeFormat else {
            throw LocalKeysImportError.notAKeyBundle
        }
        guard envelope.formatVersion == formatVersion else {
            throw LocalKeysImportError.unsupportedVersion(envelope.formatVersion)
        }
        guard envelope.kdf == "pbkdf2-hmac-sha256" else {
            throw LocalKeysImportError.unsupportedKdf
        }
        if envelope.iterations < minIterations {
            throw LocalKeysImportError.weakIterations(envelope.iterations)
        }
        if envelope.iterations > maxIterations {
            throw LocalKeysImportError.excessiveIterations(envelope.iterations)
        }
        guard let salt = Data(base64Encoded: envelope.salt), salt.count == 16 else {
            throw LocalKeysImportError.malformedField("salt")
        }
        guard let nonce = Data(base64Encoded: envelope.nonce), nonce.count == 12 else {
            throw LocalKeysImportError.malformedField("nonce")
        }
        guard let ciphertext = Data(base64Encoded: envelope.ciphertext), ciphertext.count > 16 else {
            throw LocalKeysImportError.malformedField("ciphertext")
        }

        let key = try deriveKey(passphrase: passphrase, salt: salt, iterations: envelope.iterations)
        let plaintext: Data
        do {
            let box = try AES.GCM.SealedBox(combined: nonce + ciphertext)
            plaintext = try AES.GCM.open(box, using: key)
        } catch {
            // Wrong passphrase and tampering are indistinguishable by design.
            throw LocalKeysImportError.wrongPassphraseOrTampered
        }
        return try parsePayload(plaintext)
    }

    /// PBKDF2-HMAC-SHA256 via CommonCrypto (matches Node crypto.pbkdf2Sync).
    static func deriveKey(passphrase: String, salt: Data, iterations: Int) throws -> SymmetricKey {
        guard !passphrase.isEmpty else {
            throw LocalKeysImportError.wrongPassphraseOrTampered
        }
        var derived = [UInt8](repeating: 0, count: 32)
        let passBytes = Array(passphrase.utf8)
        let status: Int32 = passBytes.withUnsafeBufferPointer { passPtr -> Int32 in
            salt.withUnsafeBytes { saltPtr -> Int32 in
                derived.withUnsafeMutableBufferPointer { outPtr -> Int32 in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        UnsafeRawPointer(passPtr.baseAddress!).assumingMemoryBound(to: CChar.self),
                        passBytes.count,
                        saltPtr.bindMemory(to: UInt8.self).baseAddress,
                        salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        outPtr.baseAddress,
                        outPtr.count
                    )
                }
            }
        }
        guard status == Int32(kCCSuccess) else {
            throw LocalKeysImportError.wrongPassphraseOrTampered
        }
        defer {
            for i in derived.indices { derived[i] = 0 }
        }
        return SymmetricKey(data: Data(derived))
    }

    // MARK: - Payload parse

    private static func parsePayload(_ plaintext: Data) throws -> Payload {
        guard let root = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else {
            throw LocalKeysImportError.unreadablePayload
        }
        guard root["format"] as? String == payloadFormat else {
            throw LocalKeysImportError.unreadablePayload
        }
        guard root["formatVersion"] as? Int == formatVersion else {
            throw LocalKeysImportError.unsupportedVersion(root["formatVersion"] as? Int ?? 0)
        }
        var secrets: [SecretEntry] = []
        var malformed = 0
        for row in root["secrets"] as? [[String: Any]] ?? [] {
            guard let provider = row["provider"] as? String, !provider.isEmpty,
                  let apiKey = row["apiKey"] as? String, !apiKey.isEmpty
            else {
                malformed += 1
                continue
            }
            secrets.append(
                SecretEntry(
                    provider: provider,
                    apiKey: apiKey,
                    teamId: row["teamId"] as? String,
                    accountSid: row["accountSid"] as? String,
                    apiKeySid: row["apiKeySid"] as? String
                )
            )
        }
        var configData: Data?
        if let config = root["config"] as? [String: Any] {
            configData = try? JSONSerialization.data(withJSONObject: config)
        }
        return Payload(secrets: secrets, configData: configData, malformedSecretRows: malformed)
    }
}
