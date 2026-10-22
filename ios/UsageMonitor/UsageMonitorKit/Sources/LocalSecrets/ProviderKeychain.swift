import Foundation
import Security

/// Keychain storage for provider API keys (Usage Monitor Local only).
/// Never write secrets into SQLite / LocalStore.
public struct ProviderCredentials: Sendable, Equatable, Codable {
    public var apiKey: String
    /// xAI Management API team id (optional).
    public var teamId: String?
    /// Twilio Account SID (optional; key may be Auth Token or API Key secret).
    public var accountSid: String?
    /// Twilio API Key SID when using key+secret instead of auth token.
    public var apiKeySid: String?

    public init(
        apiKey: String,
        teamId: String? = nil,
        accountSid: String? = nil,
        apiKeySid: String? = nil
    ) {
        self.apiKey = apiKey
        self.teamId = teamId
        self.accountSid = accountSid
        self.apiKeySid = apiKeySid
    }

    /// JSON when extra fields present; plain UTF-8 key for simple credentials (legacy).
    public func encoded() throws -> Data {
        if teamId == nil, accountSid == nil, apiKeySid == nil {
            return Data(apiKey.utf8)
        }
        return try JSONEncoder().encode(self)
    }

    public static func decoded(from data: Data) throws -> ProviderCredentials {
        if let json = try? JSONDecoder().decode(ProviderCredentials.self, from: data),
           !json.apiKey.isEmpty {
            return json
        }
        guard let key = String(data: data, encoding: .utf8), !key.isEmpty else {
            throw ProviderKeychainError.osStatus(errSecDecode)
        }
        // Avoid treating "{" as a bare key that is invalid JSON credentials.
        if key.first == "{" {
            throw ProviderKeychainError.osStatus(errSecDecode)
        }
        return ProviderCredentials(apiKey: key)
    }
}

public protocol ProviderSecretStoring: Sendable {
    func save(accountId: String, credentials: ProviderCredentials) throws
    func load(accountId: String) throws -> ProviderCredentials?
    func delete(accountId: String) throws
}

public struct ProviderKeychainStore: ProviderSecretStoring, Sendable {
    public static let shared = ProviderKeychainStore()

    private let service = "services.jays.usage.local.monitor.provider-keys"

    public init() {}

    public func save(accountId: String, credentials: ProviderCredentials) throws {
        let data = try credentials.encoded()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw ProviderKeychainError.osStatus(status)
        }
    }

    public func load(accountId: String) throws -> ProviderCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw ProviderKeychainError.osStatus(status)
        }
        return try ProviderCredentials.decoded(from: data)
    }

    public func delete(accountId: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountId,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProviderKeychainError.osStatus(status)
        }
    }
}

public enum ProviderKeychainError: Error, Equatable, Sendable {
    case osStatus(OSStatus)
}
