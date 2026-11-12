import Foundation
import Security

/// The monitor token is scoped to its server URL and never stored in preferences.
enum TokenStore {
    private static let service = "com.jays.usage-monitor.mac.read-token"

    private static let keychainGate = DispatchSemaphore(value: 1)

    static func read(server: String) async -> String? {
        await perform(nil) { readSynchronously(server: server) }
    }

    private static func readSynchronously(server: String) -> String? {
        var query = base(server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String, server: String) async throws {
        let status = await perform(OSStatus(errSecInteractionNotAllowed)) { saveSynchronously(token, server: server) }
        guard status == errSecSuccess else { throw Failure.write }
    }

    private static func saveSynchronously(_ token: String, server: String) -> OSStatus {
        let query = base(server)
        let attributes = [kSecValueData as String: Data(token.utf8)] as [String: Any]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query.merging(attributes) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(item as CFDictionary, nil)
        }
        return status
    }

    static func delete(server: String) async throws {
        let status = await perform(OSStatus(errSecInteractionNotAllowed)) { SecItemDelete(base(server) as CFDictionary) }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.write }
    }

    /// Only explicit Settings actions reach Keychain.  Keep the action pending
    /// while macOS handles its prompt; do not return early and retry a live call.
    private static func perform<Value: Sendable>(_ fallback: Value, operation: @escaping @Sendable () -> Value) async -> Value {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                guard keychainGate.wait(timeout: .now()) == .success else { continuation.resume(returning: fallback); return }
                let result = operation()
                keychainGate.signal()
                continuation.resume(returning: result)
            }
        }
    }

    private static func base(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: server]
    }

    enum Failure: LocalizedError {
        case read, write
        var errorDescription: String? {
            switch self {
            case .read: return "Open Settings and use Save & Refresh to connect the saved server token for this app session."
            case .write: return "Keychain could not save the connection.  Unlock your login Keychain and try again."
            }
        }
    }
}
