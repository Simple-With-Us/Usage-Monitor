import XCTest
import SwiftUI
import UIKit
import Foundation
import AppCore
import DesignSystem
import Models
import Networking
@testable import ServerStatus

/// Renders the Server Status "B2 Usage by Application" daily chart in light
/// and dark mode and writes the PNGs to `B2_SCREENSHOT_DIR` (set by
/// `scripts/ios-b2-screenshots.sh`).  Hosted iOS CI uploads that directory as
/// an artifact, so the designer reviews a simulator-backed capture instead of
/// a hand-made screenshot.
///
/// The fixture deliberately shows the review points: several days of stacked
/// bars split across three apps, an emerald "Left" (remaining) segment on the
/// days under the free cap, and one day over the cap.
@MainActor
final class B2ChartVisualCaptureTests: XCTestCase {
    /// iPhone 15/16 logical width, tall enough for the card plus every daily row.
    private static let captureSize = CGSize(width: 393, height: 852)

    override func tearDown() {
        B2ChartURLProtocol.handler = nil
        super.tearDown()
    }

    func testCaptureB2DailyChart() async throws {
        guard let dir = ProcessInfo.processInfo.environment["B2_SCREENSHOT_DIR"] else {
            throw XCTSkip("B2_SCREENSHOT_DIR is unset; run via scripts/ios-b2-screenshots.sh")
        }
        let output = URL(fileURLWithPath: dir)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let store = await makeLoadedStore()
        XCTAssertNotNil(store.state.value, "the B2 fixture must load before the chart is rendered")

        let captures: [(ColorScheme, String)] = [
            (.light, "b2-daily-chart-light.png"),
            (.dark, "b2-daily-chart-dark.png"),
        ]
        for (scheme, name) in captures {
            let view = AnyView(
                B2AppUsageSection(store: store, hasCredential: true) { }
                    .frame(width: Self.captureSize.width, height: Self.captureSize.height)
                    .background(Theme.Colors.background)
                    // The window's `overrideUserInterfaceStyle` resolves the
                    // dynamic `Theme.Colors` tokens;  the environment values
                    // keep the SwiftUI tree in the same scheme.
                    .environment(\.colorScheme, scheme)
                    .preferredColorScheme(scheme)
            )
            let url = output.appendingPathComponent(name)
            try await Self.writePNG(of: view, scheme: scheme, to: url)
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), name)
            XCTAssertTrue(
                Self.hasVisibleContent(of: url),
                "\(name) looks blank; the daily chart did not render"
            )
        }
    }

    /// Loads the store through the real `APIClient` path, with the HTTP call
    /// stubbed by `B2ChartURLProtocol` (the pattern the other store tests use).
    private func makeLoadedStore() async -> B2AppUsageStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [B2ChartURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: "test-token"),
            session: session
        )
        B2ChartURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/b2-app-usage")
            return b2ChartFixtureJSON
        }

        let store = B2AppUsageStore()
        await store.load(using: client)
        return store
    }

    /// Captures the chart through a real `UIWindow`.  `ImageRenderer` cannot
    /// draw UIKit-backed views, and `drawHierarchy(in:afterScreenUpdates:)`
    /// needs a render server that the host-less package test runner does not
    /// have, so the capture draws the layer tree in-process with
    /// `CALayer.render(in:)`, which still paints the segmented pickers and the
    /// legend's `UIScrollView` content.
    private static func writePNG(of root: AnyView, scheme: ColorScheme, to url: URL) async throws {
        let window = makeWindow(size: captureSize)
        window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light

        let hosting = UIHostingController(rootView: root)
        hosting.view.frame = window.bounds
        hosting.view.backgroundColor = .clear
        window.rootViewController = hosting
        window.makeKeyAndVisible()

        hosting.view.setNeedsLayout()
        hosting.view.layoutIfNeeded()
        // SwiftUI needs a few run-loop turns to settle the pickers, the bars
        // and the scroll view before the hierarchy is drawn.
        try await Task.sleep(for: .milliseconds(300))
        hosting.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))

        // One more layout pass so the layer tree is settled before it is drawn.
        window.layoutIfNeeded()
        hosting.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 2
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds, format: format)
        let image = renderer.image { context in
            window.layer.render(in: context.cgContext)
        }

        // Tear the window down so the next capture starts from a clean slate.
        window.isHidden = true
        window.rootViewController = nil

        guard let data = image.pngData() else {
            XCTFail("PNG encoding failed for \(url.lastPathComponent)")
            return
        }
        try data.write(to: url, options: .atomic)
    }

    /// A window scene only exists when the tests run inside a real app host.
    /// The package tests run in a host-less XCTest runner, so the plain
    /// `UIWindow(frame:)` fallback is the normal path there.
    private static func makeWindow(size: CGSize) -> UIWindow {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let scene = scenes.first(where: { $0.activationState != .unattached }) ?? scenes.first {
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(origin: .zero, size: size)
            return window
        }
        return UIWindow(frame: CGRect(origin: .zero, size: size))
    }

    /// Cheap blank-image guard: a downscaled sample of the PNG must contain
    /// more than one color, otherwise the capture is a flat background and the
    /// artifact would be useless to the reviewer.
    private static func hasVisibleContent(of url: URL) -> Bool {
        guard
            let data = try? Data(contentsOf: url),
            let image = UIImage(data: data),
            let cgImage = image.cgImage
        else { return false }

        let side = 24
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        return pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard
                let base = buffer.baseAddress,
                let context = CGContext(
                    data: UnsafeMutableRawPointer(base),
                    width: side,
                    height: side,
                    bitsPerComponent: 8,
                    bytesPerRow: side * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )
            else { return true }

            context.interpolationQuality = .low
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))

            func pixel(at offset: Int) -> (UInt8, UInt8, UInt8, UInt8) {
                (
                    base.load(fromByteOffset: offset, as: UInt8.self),
                    base.load(fromByteOffset: offset + 1, as: UInt8.self),
                    base.load(fromByteOffset: offset + 2, as: UInt8.self),
                    base.load(fromByteOffset: offset + 3, as: UInt8.self)
                )
            }

            let first = pixel(at: 0)
            for offset in stride(from: 4, to: buffer.count, by: 4) where pixel(at: offset) != first {
                return true
            }
            return false
        }
    }
}

/// Fixture payload for `GET /api/b2-app-usage`, shaped like the wire payload
/// the server returns.  The daily free cap is 1 GB of downloads, so every day
/// except 2026-10-20 leaves an emerald "Left" segment and 2026-10-20 is over
/// the cap.
private let b2ChartFixtureJSON = """
{
  "configured": true,
  "asOf": "2026-10-23T00:00:00.000Z",
  "cacheAgeSeconds": 0,
  "reportDate": "2026-10-22",
  "storageSource": "external_billing",
  "reportSource": "usage_csv",
  "warnings": [],
  "caps": { "classCDailyFree": 2500, "downloadGbDailyFree": 1 },
  "alerts": { "classCNearCap": false, "downloadNearCap": false, "classCSpike": false },
  "apps": [
    {
      "id": "socratic-trade",
      "label": "Socratic.Trade",
      "bucketNames": ["jays-socratic-trade-eu"],
      "storageGb": 148.2,
      "latestDay": {
        "date": "2026-10-22",
        "storedGb": 148.2,
        "downloadedGb": 0.3,
        "classCTransactions": 1200,
        "classBTransactions": 40
      }
    },
    {
      "id": "congress-trade",
      "label": "Congress.Trade",
      "bucketNames": ["jays-congress-trade"],
      "storageGb": 92.4,
      "latestDay": {
        "date": "2026-10-22",
        "storedGb": 92.4,
        "downloadedGb": 0.1,
        "classCTransactions": 800,
        "classBTransactions": 12
      }
    },
    {
      "id": "usage-monitor",
      "label": "Usage Monitor",
      "bucketNames": ["jays-usage-monitor"],
      "storageGb": 12.7,
      "latestDay": {
        "date": "2026-10-22",
        "storedGb": 12.7,
        "downloadedGb": 0.15,
        "classCTransactions": 240,
        "classBTransactions": 4
      }
    }
  ],
  "dailySeries": [
    {
      "date": "2026-10-22",
      "accountDownloadedGb": 0.55,
      "accountClassCTotal": 2240,
      "byApp": {
        "socratic-trade": { "downloadedGb": 0.3, "classCTransactions": 1200 },
        "congress-trade": { "downloadedGb": 0.1, "classCTransactions": 800 },
        "usage-monitor": { "downloadedGb": 0.15, "classCTransactions": 240 }
      }
    },
    {
      "date": "2026-10-21",
      "accountDownloadedGb": 0.8,
      "accountClassCTotal": 3100,
      "byApp": {
        "socratic-trade": { "downloadedGb": 0.45, "classCTransactions": 1800 },
        "congress-trade": { "downloadedGb": 0.2, "classCTransactions": 900 },
        "usage-monitor": { "downloadedGb": 0.15, "classCTransactions": 400 }
      }
    },
    {
      "date": "2026-10-20",
      "accountDownloadedGb": 1.3,
      "accountClassCTotal": 4200,
      "byApp": {
        "socratic-trade": { "downloadedGb": 0.6, "classCTransactions": 2200 },
        "congress-trade": { "downloadedGb": 0.45, "classCTransactions": 1400 },
        "usage-monitor": { "downloadedGb": 0.25, "classCTransactions": 600 }
      }
    },
    {
      "date": "2026-10-19",
      "accountDownloadedGb": 0.25,
      "accountClassCTotal": 980,
      "byApp": {
        "congress-trade": { "downloadedGb": 0.1, "classCTransactions": 500 },
        "usage-monitor": { "downloadedGb": 0.15, "classCTransactions": 480 }
      }
    },
    {
      "date": "2026-10-18",
      "accountDownloadedGb": 0.95,
      "accountClassCTotal": 3600,
      "byApp": {
        "socratic-trade": { "downloadedGb": 0.5, "classCTransactions": 2000 },
        "congress-trade": { "downloadedGb": 0.3, "classCTransactions": 1100 },
        "usage-monitor": { "downloadedGb": 0.15, "classCTransactions": 500 }
      }
    }
  ]
}
""".data(using: .utf8)!

/// Stub transport for `GET /api/b2-app-usage`, mirroring the URLProtocol
/// harness the other store tests use.
private final class B2ChartURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) async throws -> Data)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task {
            do {
                guard let handler = Self.handler else {
                    throw URLError(.badServerResponse)
                }
                let body = try await handler(request)
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: body)
                client?.urlProtocolDidFinishLoading(self)
            } catch {
                client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {}
}
