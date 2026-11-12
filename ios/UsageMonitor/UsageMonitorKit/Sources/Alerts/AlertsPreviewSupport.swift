#if DEBUG
import SwiftUI
import Foundation
import Models
import Networking
import AppCore

// ---------------------------------------------------------------------------
// Preview-only scaffolding. Feeds a real `BudgetStore` from a stubbed
// URLSession so previews exercise the true loaded/empty/error paths without a
// network — no production code depends on any of this.
// ---------------------------------------------------------------------------

/// A `URLProtocol` that answers every request with a canned status + body.
final class AlertsStubURLProtocol: URLProtocol {
    struct Stub: Sendable { var statusCode: Int; var data: Data }
    nonisolated(unsafe) static var stub = Stub(statusCode: 200, data: Data())

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let stub = Self.stub
        if let url = request.url,
           let response = HTTPURLResponse(
                url: url,
                statusCode: stub.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
           ) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: stub.data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
enum AlertsPreview {
    /// A `BudgetStore` whose fetch returns `response` (HTTP 200) via the stub.
    static func store(_ response: BudgetStatusResponse = .sample) -> BudgetStore {
        AlertsStubURLProtocol.stub = .init(
            statusCode: 200,
            data: (try? JSONEncoder().encode(response)) ?? Data()
        )
        return BudgetStore(apiClient: stubClient(token: "preview-token"))
    }

    /// A `BudgetStore` whose fetch fails (no stored token → `.missingToken`).
    static func failingStore() -> BudgetStore {
        BudgetStore(apiClient: stubClient(token: nil))
    }

    /// An `AlertsModel` on a throwaway defaults suite, optionally pre-seeded
    /// with resolved alerts.
    static func model(resolved: [ResolvedAlert] = []) -> AlertsModel {
        let defaults = UserDefaults(suiteName: "preview.alerts.\(UUID().uuidString)") ?? .standard
        let tracker = ResolvedAlertTracker(defaults: defaults)
        tracker.seedForPreview(resolved: resolved)
        return AlertsModel(tracker: tracker)
    }

    static let sampleResolved: [ResolvedAlert] = [
        ResolvedAlert(
            providerId: "prov_gemini",
            providerTitle: "Google Gemini",
            code: "budget_warning",
            severity: .warning,
            message: "Gemini dropped back under 80% of its monthly budget.",
            resolvedAt: Date().addingTimeInterval(-2 * 60 * 60)
        ),
        ResolvedAlert(
            providerId: "prov_openai",
            providerTitle: "OpenAI",
            code: "stale_snapshot",
            severity: .info,
            message: "A fresh usage snapshot arrived; data is current again.",
            resolvedAt: Date().addingTimeInterval(-26 * 60 * 60)
        ),
    ]

    private static func stubClient(token: String?) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AlertsStubURLProtocol.self]
        return APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: token),
            session: URLSession(configuration: configuration)
        )
    }
}

// MARK: - Previews

#Preview("Alerts · Active + Resolved · Light") {
    AlertsRootView(model: AlertsPreview.model(resolved: AlertsPreview.sampleResolved))
        .environment(AlertsPreview.store())
        .preferredColorScheme(.light)
}

#Preview("Alerts · Active + Resolved · Dark") {
    AlertsRootView(model: AlertsPreview.model(resolved: AlertsPreview.sampleResolved))
        .environment(AlertsPreview.store())
        .preferredColorScheme(.dark)
}

#Preview("Alerts · All clear · Light") {
    AlertsRootView(model: AlertsPreview.model())
        .environment(AlertsPreview.store(.sampleEmpty))
        .preferredColorScheme(.light)
}

#Preview("Alerts · All clear · Dark") {
    AlertsRootView(model: AlertsPreview.model())
        .environment(AlertsPreview.store(.sampleEmpty))
        .preferredColorScheme(.dark)
}

#Preview("Alerts · Error · Light") {
    AlertsRootView(model: AlertsPreview.model())
        .environment(AlertsPreview.failingStore())
        .preferredColorScheme(.light)
}

#Preview("Alerts · Error · Dark") {
    AlertsRootView(model: AlertsPreview.model())
        .environment(AlertsPreview.failingStore())
        .preferredColorScheme(.dark)
}

#Preview("Provider detail · Light") {
    NavigationStack {
        ProviderAlertDetailView(providerId: "prov_openrouter", fallback: .sampleExceeded)
            .environment(AlertsPreview.store())
    }
    .preferredColorScheme(.light)
}

#Preview("Provider detail · Dark") {
    NavigationStack {
        ProviderAlertDetailView(providerId: "prov_anthropic", fallback: .sampleWarning)
            .environment(AlertsPreview.store())
    }
    .preferredColorScheme(.dark)
}
#endif
