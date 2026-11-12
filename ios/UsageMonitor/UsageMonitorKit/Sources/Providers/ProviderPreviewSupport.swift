#if DEBUG
import Foundation
import Networking
import AppCore
import Models

// ---------------------------------------------------------------------------
// DEBUG-only helpers that let SwiftUI previews render the Providers screens
// against a fully-seeded `BudgetStore` without a live network. A tiny
// `URLProtocol` stub feeds a canned `budget-status` response through the real
// `APIClient`/`BudgetStore` path, so previews exercise the exact production code
// (not a parallel mock). Never compiled into release builds.
// ---------------------------------------------------------------------------

/// Returns a canned HTTP response for any request. The payload is set just
/// before a session is used, so one stub serves a single seeded response.
final class PreviewURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responseData = Data()
    nonisolated(unsafe) static var statusCode = 200

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url,
           let http = HTTPURLResponse(
               url: url,
               statusCode: Self.statusCode,
               httpVersion: "HTTP/1.1",
               headerFields: ["Content-Type": "application/json"]
           ) {
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        }
        client?.urlProtocol(self, didLoad: Self.responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

enum ProviderPreview {
    /// Build a `BudgetStore` whose `budgetStatus()` resolves to `response`.
    @MainActor
    static func store(with response: BudgetStatusResponse) -> BudgetStore {
        PreviewURLProtocol.responseData = (try? JSONEncoder().encode(response)) ?? Data()
        PreviewURLProtocol.statusCode = 200

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PreviewURLProtocol.self]
        let session = URLSession(configuration: config)

        let client = APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: "preview-token"),
            session: session
        )
        return BudgetStore(apiClient: client)
    }

    /// The default seeded store used by list previews.
    @MainActor
    static var sampleStore: BudgetStore { store(with: .sample) }
}
#endif
