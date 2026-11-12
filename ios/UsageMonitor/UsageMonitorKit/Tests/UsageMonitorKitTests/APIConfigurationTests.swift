import XCTest
@testable import Networking

final class APIConfigurationTests: XCTestCase {
    func testHostWithoutSchemeDefaultsToHTTPSAndNormalizesOrigin() {
        let configuration = APIConfiguration.fromUserInput("  USAGE.EXAMPLE.COM:8443///  ")

        XCTAssertEqual(configuration?.baseURL.absoluteString, "https://usage.example.com:8443")
    }

    func testRejectsPlaintextHTTP() {
        XCTAssertNil(APIConfiguration.fromUserInput("http://usage.example.com"))
        XCTAssertNil(APIConfiguration.fromUserInput("http://localhost:3000"))
    }

    func testRejectsCredentialsAndNonOriginComponents() {
        XCTAssertNil(APIConfiguration.fromUserInput("https://owner:secret@usage.example.com"))
        XCTAssertNil(APIConfiguration.fromUserInput("https://usage.example.com/api"))
        XCTAssertNil(APIConfiguration.fromUserInput("https://usage.example.com?token=secret"))
        XCTAssertNil(APIConfiguration.fromUserInput("https://usage.example.com#settings"))
    }

    func testRejectsMissingOrMalformedHost() {
        XCTAssertNil(APIConfiguration.fromUserInput(""))
        XCTAssertNil(APIConfiguration.fromUserInput("https://"))
        XCTAssertNil(APIConfiguration.fromUserInput("not a host"))
    }
}
