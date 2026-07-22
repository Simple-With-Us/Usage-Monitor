import Foundation
import Security

/// Secure storage for the usage read token.
///
/// The token is a bearer credential (`USAGE_READ_TOKEN` / `USAGE_INGEST_TOKEN`
/// on the server) that grants read access to budget data, so it is stored in
/// the Keychain — never `UserDefaults`. The protocol lets tests and previews
/// substitute an in-memory store.
public protocol TokenStoring: Sendable {
    /// The currently stored token, or `nil` when none has been saved.
    func token() -> String?
    /// Persist a token. Passing `nil` or an empty string clears it.
    func setToken(_ token: String?) throws
    /// Whether a non-empty token is currently stored.
    var hasToken: Bool { get }
}

public extension TokenStoring {
    var hasToken: Bool {
        guard let token = token() else { return false }
        return !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Errors thrown while writing to the Keychain.
public enum TokenStoreError: Error, Equatable, Sendable {
    case keychain(OSStatus)
    case encoding
}

/// Keychain-backed implementation. The token is stored as a generic password
/// item keyed by `service` + `account`, with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so a background refresh /
/// widget timeline can read it after the first unlock following a reboot without
/// allowing this bearer credential to migrate in an encrypted device backup.
public struct KeychainTokenStore: TokenStoring {
    private let service: String
    private let account: String

    public init(
        service: String = "services.jays.usage.monitor",
        account: String = "usage-read-token"
    ) {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func token() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else {
            return nil
        }
        return token
    }

    public func setToken(_ token: String?) throws {
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else {
            let status = SecItemDelete(baseQuery as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw TokenStoreError.keychain(status)
            }
            return
        }

        guard let data = trimmed.data(using: .utf8) else {
            throw TokenStoreError.encoding
        }

        // Try update-in-place first; fall back to insert.
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        if updateStatus == errSecItemNotFound {
            var insert = baseQuery
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw TokenStoreError.keychain(addStatus)
            }
            return
        }
        throw TokenStoreError.keychain(updateStatus)
    }
}

/// In-memory store for previews, unit tests, and SwiftUI canvas. Thread-safe.
public final class InMemoryTokenStore: TokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var _token: String?

    public init(token: String? = nil) {
        self._token = token
    }

    public func token() -> String? {
        lock.lock(); defer { lock.unlock() }
        return _token
    }

    public func setToken(_ token: String?) throws {
        lock.lock(); defer { lock.unlock() }
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        _token = (trimmed?.isEmpty ?? true) ? nil : trimmed
    }
}
