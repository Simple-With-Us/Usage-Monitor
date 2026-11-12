import Foundation

/// User-visible product name from the hosting app target.
///
/// Prefer the plain App Store / home-screen name (`CFBundleDisplayName`):
/// **Usage Monitor** or **Local Monitor**. Do not invent a third
/// brand string in kit UI. Bundle IDs stay out of user-facing copy unless the
/// screen is explicitly about identity/debug.
public enum AppProductName: Sendable {
    public static var displayName: String {
        if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return name
        }
        if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String,
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return name
        }
        return "App"
    }
}
