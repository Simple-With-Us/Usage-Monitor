import Foundation
import LocalAuthentication
#if canImport(UIKit)
import UIKit
#endif

// ---------------------------------------------------------------------------
// Small, dependency-light helpers for the Settings lane: biometry detection
// (for an accurately-labelled app-lock toggle) and app version info for the
// About section. Haptics are centralized in DesignSystem — import and use
// `DesignSystem.Haptics` instead.
// ---------------------------------------------------------------------------

/// What biometric hardware (if any) this device has, so the app-lock row can
/// say "Require Face ID" / "Require Touch ID" instead of a generic label.
struct BiometryInfo: Equatable {
    let isAvailable: Bool
    let type: LABiometryType

    /// The human name of the enrolled biometry, or a passcode fallback phrase.
    var label: String {
        switch type {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "your passcode"
        }
    }

    var systemImage: String {
        switch type {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        default: return "lock.fill"
        }
    }

    /// A one-line description of what unlocking will require.
    var requirementCaption: String {
        if isAvailable {
            return "Unlock the app with \(label) each time it opens or returns from the background."
        }
        return "Unlock the app with your device passcode each time it opens or returns from the background."
    }

    static func current() -> BiometryInfo {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            error: &error
        )
        return BiometryInfo(isAvailable: available, type: context.biometryType)
    }
}

/// Bundle-sourced app identity for the About section.
enum AppInfo {
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    static var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    /// Plain user-facing app name (Usage Monitor Client / Usage Monitor Local).
    static var displayName: String {
        (Bundle.main.infoDictionary?["CFBundleDisplayName"] as? String)
            ?? (Bundle.main.infoDictionary?["CFBundleName"] as? String)
            ?? "App"
    }

    /// Last Settings footer.  Two spaces after the first sentence so the
    /// line stays owner-copy-legal and testable without a running UI.
    static var aboutFooter: String {
        "\(displayName) shows your AI provider budgets at a glance.  Data stays on your device and the monitor you point it at."
    }
}

// UptimeFormat / DiskFormat live in DesignSystem (shared with ServerStatus).
