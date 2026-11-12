import Foundation
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Centralized haptic feedback

/// Single, canonical haptic-feedback helper for the entire app. All calls are
/// `@MainActor` (UIKit feedback generators require the main thread) and
/// transparent no-ops where UIKit is unavailable (previews, tests).
///
/// Before this consolidation, each feature lane owned a near-identical copy
/// (`DashboardHaptics`, `AlertsHaptics`, `ProviderHaptics`, and two separate
/// `Haptics` enums). The duplicates have been removed — every caller now
/// reaches this single definition through the `DesignSystem` import every
/// feature already has.
@MainActor
public enum Haptics {
    // MARK: Notification feedback (success / warning / error)

    public static func success() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    public static func warning() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        #endif
    }

    public static func error() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        #endif
    }

    // MARK: Selection feedback

    public static func selection() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    // MARK: Impact feedback

    /// A light tap — for confirming a row tap / navigation.
    public static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    /// A parameterized impact — for filter changes, sort changes, etc.
    public static func impact(_ style: ImpactStyle = .light) {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: style.uiKitStyle).impactOccurred()
        #endif
    }

    // MARK: Parameterized notification

    public static func notify(_ type: NotificationType) {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(type.uiKitType)
        #endif
    }
}

// MARK: - Portability types

/// Mirrors `UINotificationFeedbackGenerator.FeedbackType` so callers never
/// need to import UIKit just to describe a haptic intent.
public enum NotificationType: Sendable {
    case success
    case warning
    case error

    #if canImport(UIKit)
    var uiKitType: UINotificationFeedbackGenerator.FeedbackType {
        switch self {
        case .success: return .success
        case .warning: return .warning
        case .error: return .error
        }
    }
    #endif
}

/// Mirrors `UIImpactFeedbackGenerator.FeedbackStyle` so callers never need to
/// import UIKit just to pick a haptic weight.
public enum ImpactStyle: Sendable {
    case light
    case medium
    case heavy
    case soft
    case rigid

    #if canImport(UIKit)
    var uiKitStyle: UIImpactFeedbackGenerator.FeedbackStyle {
        switch self {
        case .light: return .light
        case .medium: return .medium
        case .heavy: return .heavy
        case .soft: return .soft
        case .rigid: return .rigid
        }
    }
    #endif
}
