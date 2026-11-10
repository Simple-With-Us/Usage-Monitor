#if DEBUG
import Foundation
import Models
import Networking
import AppCore

// ---------------------------------------------------------------------------
// Preview-only scaffolding (compiled only in DEBUG, i.e. for SwiftUI previews).
//
// Full-screen previews need a real `BudgetStore` in a loaded (or failed) state,
// but its `state` is private and only mutated by fetching. Rather than reach
// into it, we stand up an in-memory HTTP stub so a genuine `APIClient` →
// `BudgetStore` pipeline loads fixture data — exercising the real load path.
// ---------------------------------------------------------------------------

/// An in-memory `URLProtocol` that answers every request with a preset payload
/// and status. Used only to back preview `BudgetStore`s.
final class PreviewStubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var payload = Data()
    nonisolated(unsafe) static var statusCode = 200

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url,
           let response = HTTPURLResponse(
                url: url,
                statusCode: Self.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
           ) {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.payload)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Builds preview `BudgetStore`s wired to the in-memory stub.
enum DashboardPreview {
    /// A store that will load `response` (or fail with `statusCode` when non-2xx)
    /// the first time a view drives `loadIfNeeded()`.
    @MainActor
    static func store(_ response: BudgetStatusResponse = .sample, statusCode: Int = 200) -> BudgetStore {
        PreviewStubURLProtocol.payload = (try? JSONEncoder().encode(response)) ?? Data()
        PreviewStubURLProtocol.statusCode = statusCode

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewStubURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let client = APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: "preview-token"),
            session: session
        )
        return BudgetStore(apiClient: client)
    }

    /// A `QuotaWindowsStore` plus the stubbed `APIClient` it should be driven
    /// with — `QuotaWindowsStore.loadIfNeeded(using:)` takes the client
    /// explicitly rather than holding one, unlike `BudgetStore` above.
    @MainActor
    static func quotaWindowsStore(
        _ response: QuotaWindowsResponse = .sample,
        statusCode: Int = 200
    ) -> (store: QuotaWindowsStore, client: APIClient) {
        PreviewStubURLProtocol.payload = (try? JSONEncoder().encode(response)) ?? Data()
        PreviewStubURLProtocol.statusCode = statusCode

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewStubURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let client = APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: "preview-token"),
            session: session
        )
        return (QuotaWindowsStore(), client)
    }
}
#endif
