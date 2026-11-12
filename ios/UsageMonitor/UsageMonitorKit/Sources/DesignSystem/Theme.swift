import SwiftUI

// ---------------------------------------------------------------------------
// The design system's single source of truth for color, type, spacing, and
// shape. Every screen is built from these tokens so the app reads as one
// cohesive, native product in both light and dark mode with full Dynamic Type.
//
// DesignSystem is intentionally MODEL-FREE (it has no dependency on the Models
// target). Components take primitive values plus a `SemanticStatus`; feature
// modules map their domain types (BudgetLevel, AlertSeverity, CostCoverage)
// onto `SemanticStatus` at the call site. See ARCHITECTURE-CONTRACT.md.
// ---------------------------------------------------------------------------

public enum Theme {}

// MARK: - Color tokens

public extension Theme {
    enum Colors {
        // Backgrounds — grouped-list hierarchy so cards float above the page.
        public static let background = Color(uiColor: .systemGroupedBackground)
        public static let surface = Color(uiColor: .secondarySystemGroupedBackground)
        public static let surfaceElevated = Color(uiColor: .tertiarySystemGroupedBackground)
        public static let fill = Color(uiColor: .secondarySystemFill)
        public static let meterTrack = Color(uiColor: .tertiarySystemFill)

        // Text.
        public static let primaryText = Color(uiColor: .label)
        public static let secondaryText = Color(uiColor: .secondaryLabel)
        public static let tertiaryText = Color(uiColor: .tertiaryLabel)
        public static let separator = Color(uiColor: .separator)

        // Brand accent — orange matching web favicon / --um-accent (#f97316 light, #fb923c dark).
        public static let accent = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 1)  // #fb923c
                : UIColor(red: 0.976, green: 0.451, blue: 0.086, alpha: 1)  // #f97316
        })
        public static let accentSoft = accent.opacity(0.14)

        // Semantic status hues.
        public static let success = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.31, green: 0.82, blue: 0.51, alpha: 1)
                : UIColor(red: 0.14, green: 0.66, blue: 0.36, alpha: 1)
        })
        public static let warning = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 1.00, green: 0.74, blue: 0.28, alpha: 1)
                : UIColor(red: 0.85, green: 0.56, blue: 0.05, alpha: 1)
        })
        public static let danger = Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 1.00, green: 0.45, blue: 0.42, alpha: 1)
                : UIColor(red: 0.83, green: 0.19, blue: 0.16, alpha: 1)
        })
        public static let neutral = secondaryText
    }
}

// MARK: - Semantic status

public extension Theme {
    /// The design-system-level status a component renders. Feature modules map
    /// their domain enums onto this (e.g. `BudgetLevel.exceeded → .danger`).
    enum SemanticStatus: Sendable, Hashable, CaseIterable {
        case neutral
        case ok
        case warning
        case danger

        public var tint: Color {
            switch self {
            case .neutral: return Theme.Colors.neutral
            case .ok: return Theme.Colors.success
            case .warning: return Theme.Colors.warning
            case .danger: return Theme.Colors.danger
            }
        }

        /// A soft background wash of the tint, for badges/chips.
        public var wash: Color { tint.opacity(0.14) }
    }
}

// MARK: - Spacing scale (4pt base)

public extension Theme {
    enum Spacing {
        public static let xxs: CGFloat = 2
        public static let xs: CGFloat = 4
        public static let sm: CGFloat = 8
        public static let md: CGFloat = 12
        public static let lg: CGFloat = 16
        public static let xl: CGFloat = 20
        public static let xxl: CGFloat = 28
        public static let xxxl: CGFloat = 40

        /// Extra scroll-content margin above the anchored tab bar.  The bar
        /// itself reserves its height via `safeAreaInset`; this only clears
        /// the bottom scroll-edge fade so last rows stay readable.  (Was 96
        /// for the floating capsule bar era — combined with duplicate
        /// applications it blanked most of a tab; owner report 2026-08-31.)
        public static let tabBarClearance: CGFloat = 32
    }
}

// MARK: - Corner radii

public extension Theme {
    enum Radius {
        public static let sm: CGFloat = 8
        public static let md: CGFloat = 12
        public static let lg: CGFloat = 16
        public static let xl: CGFloat = 22
        public static let pill: CGFloat = 999
    }
}

// MARK: - Typography (system font, full Dynamic Type)

public extension Theme {
    enum Typography {
        /// Large hero number, e.g. total spend. Rounded, monospaced digits
        /// applied at the call site via `.monospacedDigit()` where needed.
        public static let hero = Font.system(.largeTitle, design: .rounded).weight(.bold)
        public static let title = Font.system(.title2, design: .rounded).weight(.semibold)
        public static let sectionHeader = Font.system(.subheadline, design: .default).weight(.semibold)
        public static let statValue = Font.system(.title3, design: .rounded).weight(.semibold)
        public static let body = Font.system(.body)
        public static let callout = Font.system(.callout)
        public static let caption = Font.system(.caption)
        public static let captionEmphasis = Font.system(.caption).weight(.semibold)
    }
}
