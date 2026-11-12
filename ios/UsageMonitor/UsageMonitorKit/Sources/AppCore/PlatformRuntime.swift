import Foundation

#if canImport(UIKit)
import UIKit
#endif

/// Cross-platform runtime facts used by launch paths that differ on
/// "Designed for iPhone" Mac installs (TestFlight / App Store).
public enum PlatformRuntime: Sendable {
    /// True when this iOS binary is running under macOS (Apple silicon iOS-on-Mac).
    public static var isIOSAppOnMac: Bool {
        #if targetEnvironment(macCatalyst)
        return true
        #elseif canImport(UIKit)
        if #available(iOS 14.0, *) {
            return ProcessInfo.processInfo.isiOSAppOnMac
        }
        return false
        #else
        return false
        #endif
    }

    /// Background task APIs (BGAppRefresh) are unreliable / often no-ops on
    /// iOS-on-Mac and have been observed to fail registration hard on some hosts.
    public static var supportsBackgroundAppRefresh: Bool {
        !isIOSAppOnMac
    }
}
