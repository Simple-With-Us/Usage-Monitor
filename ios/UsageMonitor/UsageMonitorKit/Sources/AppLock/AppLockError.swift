import Foundation

/// A biometric / passcode failure surfaced by the AppLock gate. Pure value type
/// with no `LocalAuthentication` dependency so it is trivially constructable in
/// tests and previews. The `LAError → AppLockError` mapping lives in
/// `AppLockAuthenticator.swift` (the only file that imports LocalAuthentication).
public enum AppLockError: Error, Equatable, Sendable {
    /// The user dismissed the system prompt (user / app / system cancel).
    case canceled
    /// Biometric match failed (wrong face / finger).
    case failed
    /// The user tapped the fallback control but no fallback was handled.
    case fallback
    /// Too many failed biometric attempts; biometrics are temporarily locked
    /// and the device passcode is required.
    case biometryLockout
    /// The device cannot evaluate the policy at all — no passcode set, or
    /// biometrics not available / not enrolled. Treated as fail-open by the
    /// controller so the user is never permanently locked out of a read-only
    /// monitor by a device that has no authentication configured.
    case unavailable
    /// Any other `LAError`, carrying its localized description.
    case unknown(String)

    /// A short, human-readable explanation suitable for the lock screen.
    public var message: String {
        switch self {
        case .canceled:       return "Authentication canceled."
        case .failed:         return "Authentication didn't match. Try again."
        case .fallback:       return "Choose a way to unlock."
        case .biometryLockout:return "Biometrics are locked. Use your device passcode."
        case .unavailable:    return "Authentication isn't available on this device."
        case .unknown(let m): return m.isEmpty ? "Authentication failed." : m
        }
    }
}

/// Which authentication mechanism the device offers, used to pick the lock
/// screen glyph / label so it matches what the system prompt will show.
public enum AppLockBiometry: Sendable, Equatable {
    case faceID
    case touchID
    case opticID
    /// No biometrics enrolled, but a device passcode can still gate access.
    case passcode

    /// SF Symbol representing this mechanism.
    public var symbolName: String {
        switch self {
        case .faceID:   return "faceid"
        case .touchID:  return "touchid"
        case .opticID:  return "opticid"
        case .passcode: return "lock.fill"
        }
    }

    /// Verb phrase for the unlock control, e.g. "Unlock with Face ID".
    public var unlockLabel: String {
        switch self {
        case .faceID:   return "Unlock with Face ID"
        case .touchID:  return "Unlock with Touch ID"
        case .opticID:  return "Unlock with Optic ID"
        case .passcode: return "Unlock"
        }
    }
}

/// Whether the AppLock gate can enforce a lock on this device.
public enum AppLockAvailability: Sendable, Equatable {
    case available(AppLockBiometry)
    case unavailable

    /// The glyph to show while locked, falling back to a padlock when no
    /// specific biometry is available.
    public var symbolName: String {
        switch self {
        case .available(let b): return b.symbolName
        case .unavailable:      return "lock.fill"
        }
    }
}
