import SwiftUI

/// Bottom scroll clearance for the anchored tab bar.
///
/// The Client shell draws a custom full-width bar.  On iOS 26, Form / List /
/// ScrollView still park the last rows and section footers inside the soft
/// scroll-edge fade, so the end of every tab is only readable during
/// rubber-band overscroll.  Apply this ONCE at the tab shell (RootView) and on
/// the Local system `TabView` — never on individual feature views.  Stacked
/// applications compound `safeAreaPadding` + `contentMargins` per call and
/// blanked most of the Platforms tab (owner report, 2026-08-31).
public struct TabBarScrollClearanceModifier: ViewModifier {
    public init() {}

    public func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .safeAreaPadding(.bottom, Theme.Spacing.tabBarClearance)
                .contentMargins(.bottom, Theme.Spacing.tabBarClearance, for: .scrollContent)
                .scrollEdgeEffectHidden(true, for: .bottom)
        } else {
            content
                .safeAreaPadding(.bottom, Theme.Spacing.tabBarClearance)
                .contentMargins(.bottom, Theme.Spacing.tabBarClearance, for: .scrollContent)
        }
    }
}

public extension View {
    /// Keep the last rows and footers readable above the glass tab bar.
    func tabBarScrollClearance() -> some View {
        modifier(TabBarScrollClearanceModifier())
    }
}
