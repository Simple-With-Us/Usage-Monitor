import Foundation
import LocalAuthentication

/// Abstraction over the platform biometric / passcode check so the
/// `AppLockController` state machine is fully unit-testable without a device.
/// The production conformer is `BiometricAuthenticator`; tests inject a stub.
public protocol AppLockAuthenticator: Sendable {
    /// What the device can offer *right now* (Face ID / Touch ID / passcode, or
    /// nothing). Cheap to call; the lock screen uses it to pick its glyph.
    func availability() -> AppLockAvailability

    /// Present the system authentication prompt and resolve to success or a
    /// typed `AppLockError`. Never throws — failure is modeled in the `Result`.
    func evaluate(reason: String) async -> Result<Void, AppLockError>
}

/// The real gate, backed by `LocalAuthentication`. Uses
/// `.deviceOwnerAuthentication` so that after a biometric failure the system
/// automatically offers the device passcode — that passcode path *is* the
/// graceful fallback, so the app never has to implement its own.
///
/// Holds no mutable state: a fresh `LAContext` is created per call (contexts
/// are single-use and not `Sendable`), which keeps this a `Sendable` value.
public struct BiometricAuthenticator: AppLockAuthenticator {
    /// Policy evaluated for both availability and the prompt. Owner-authentication
    /// (not the biometrics-only variant) yields the automatic passcode fallback.
    private let policy: LAPolicy = .deviceOwnerAuthentication

    public init() {}

    public func availability() -> AppLockAvailability {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(policy, error: &error) else {
            return .unavailable
        }
        switch context.biometryType {
        case .faceID:  return .available(.faceID)
        case .touchID: return .available(.touchID)
        case .opticID: return .available(.opticID)
        default:       return .available(.passcode)   // passcode-only device
        }
    }

    public func evaluate(reason: String) async -> Result<Void, AppLockError> {
        let context = LAContext()
        context.localizedFallbackTitle = "Enter Passcode"

        var canEvaluateError: NSError?
        guard context.canEvaluatePolicy(policy, error: &canEvaluateError) else {
            return .failure(AppLockError(laError: canEvaluateError))
        }

        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(policy, localizedReason: reason) { success, evalError in
                if success {
                    continuation.resume(returning: .success(()))
                } else {
                    continuation.resume(returning: .failure(AppLockError(laError: evalError)))
                }
            }
        }
    }
}

extension AppLockError {
    /// Map a `LocalAuthentication` error onto the pure `AppLockError` cases.
    init(laError: Error?) {
        guard let laError = laError as? LAError else {
            let description = (laError as NSError?)?.localizedDescription ?? ""
            self = .unknown(description)
            return
        }
        switch laError.code {
        case .userCancel, .appCancel, .systemCancel:
            self = .canceled
        case .userFallback:
            self = .fallback
        case .authenticationFailed:
            self = .failed
        case .biometryLockout:
            self = .biometryLockout
        case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
            self = .unavailable
        default:
            self = .unknown(laError.localizedDescription)
        }
    }
}
