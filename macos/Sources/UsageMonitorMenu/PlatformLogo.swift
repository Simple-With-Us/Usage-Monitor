import AppKit
import SwiftUI

/// Displays the provider mark bundled with the menu bar application.
///
/// The provider key is the canonical key used by QuotaCore.  Unknown keys
/// deliberately use a neutral SF Symbol instead of guessing at a brand.
public struct PlatformLogo: View {
    public let providerKey: String
    public let size: CGFloat

    public init(providerKey: String, size: CGFloat = 22) {
        self.providerKey = providerKey
        self.size = size
    }

    public var body: some View {
        Group {
            if let image = PlatformLogoImage.load(providerKey: providerKey) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "questionmark.circle")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private enum PlatformLogoImage {
    private static let cache = NSCache<NSString, NSImage>()

    private static let resourceNames: [String: (name: String, ext: String)] = [
        "anthropic": ("claude", "svg"),
        "claude": ("claude", "svg"),
        "openai": ("openai", "svg"),
        "codex": ("openai", "svg"),
        "google-antigravity": ("gemini", "png"),
        "antigravity": ("gemini", "png"),
        "gemini": ("gemini", "png"),
        "xai": ("grok", "svg"),
        "grok": ("grok", "svg"),
        "grok-cli": ("grok", "svg"),
        "grok-bot": ("grok", "svg"),
        "minimax": ("minimax", "svg"),
        "deepseek": ("deepseek", "svg"),
        "cursor": ("cursor", "png"),
    ]

    static func load(providerKey: String) -> NSImage? {
        let key = providerKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let resource = resourceNames[key],
              let url = Bundle.module.url(forResource: resource.name, withExtension: resource.ext)
                  ?? Bundle.module.url(
                      forResource: resource.name,
                      withExtension: resource.ext,
                      subdirectory: "ProviderMarks"
                  ),
              let cached = cache.object(forKey: key as NSString) ?? NSImage(contentsOf: url) else {
            return nil
        }
        if cache.object(forKey: key as NSString) == nil {
            cached.isTemplate = false
            cache.setObject(cached, forKey: key as NSString)
        }
        return cached
    }
}
