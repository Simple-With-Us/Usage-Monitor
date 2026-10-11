import Foundation

/// On-device money-truth store for **Usage Local Monitor**.
///
/// Schema authority: `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md` §2.2.1.
///
/// Isolation rules:
/// - Lives only in the Local app process (bundle `com.simplewithus.usage.local.ios`).
/// - Never write provider API key material here (Keychain only).
/// - Never share a database file with the remote client app group.
public protocol LocalStoring: Sendable {
    var schemaVersion: Int { get async }
    func open() async throws
    func wipeAll() async throws
}

public enum LocalStoreError: Error, Equatable, Sendable {
    case notOpen
    case migrationFailed(String)
    case unsupportedSchema(found: Int, expected: Int)
}

/// Back-compat alias used by early scaffold UI.
public typealias PlaceholderLocalStore = SQLiteLocalStore
