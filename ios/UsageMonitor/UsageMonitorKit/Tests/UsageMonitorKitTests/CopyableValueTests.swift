import XCTest
import SwiftUI
@testable import DesignSystem

final class CopyableValueTests: XCTestCase {
    func testCopyableValueModifierAttachesToView() {
        let textView = Text("Apple M5").copyableValue("Apple M5", label: "Chip")
        XCTAssertNotNil(textView)
    }

    func testCopyableRowModifierAttachesToView() {
        let rowView = LabeledContent("Host", value: "usage.jays.services")
            .copyableRow(label: "Host", value: "usage.jays.services")
        XCTAssertNotNil(rowView)
    }

    func testCopyableLabeledContentInstantiates() {
        let copyableContent = CopyableLabeledContent("System", value: "macOS 15.4")
        XCTAssertNotNil(copyableContent)
        
        let customContent = CopyableLabeledContent("Status", valueString: "Online") {
            Text("Active")
        }
        XCTAssertNotNil(customContent)
    }
}
