import Foundation
import Security

enum ClaudeCredentialSource {
    private static let worker = DispatchQueue(label: "com.jays.usage-monitor.claude-keychain")
    private static let activeRead = DispatchSemaphore(value: 1)
    /// Only call from the explicit Connect Claude action.  The legacy login
    /// Keychain can still display an ACL prompt with authentication UI disabled.
    /// Keep the action pending until Security returns so a late prompt cannot
    /// outlive a timeout and invite another connection attempt.
    static func connect() async -> Data? {
        await withCheckedContinuation { continuation in
            guard activeRead.wait(timeout: .now()) == .success else { continuation.resume(returning: nil); return }
            worker.async {
                let data = readSynchronously()
                activeRead.signal()
                continuation.resume(returning: data)
            }
        }
    }

    private static func readSynchronously() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Claude Code-credentials",
            kSecReturnAttributes as String: true,
            kSecReturnPersistentRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]],
              let newest = items.max(by: {
                  ($0[kSecAttrModificationDate as String] as? Date ?? .distantPast)
                    < ($1[kSecAttrModificationDate as String] as? Date ?? .distantPast)
              }), let reference = newest[kSecValuePersistentRef as String] as? Data else { return nil }
        let dataQuery: [String: Any] = [
            kSecValuePersistentRef as String: reference,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var payload: CFTypeRef?
        guard SecItemCopyMatching(dataQuery as CFDictionary, &payload) == errSecSuccess,
              let data = payload as? Data, data.count <= 65_536 else { return nil }
        return data
    }
}

