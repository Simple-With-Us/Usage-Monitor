import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Native iOS Settings-Style Long-Press Copy

/// A view modifier that enables native iOS Settings-style press-and-hold (long press)
/// to copy a value or key-value pair to the system clipboard with tactile haptics.
public struct CopyableValueModifier: ViewModifier {
    private let value: String
    private let label: String?

    public init(value: String, label: String? = nil) {
        self.value = value
        self.label = label
    }

    public func body(content: Content) -> some View {
        content
            .textSelection(.enabled)
            .contextMenu {
                Button {
                    copyToClipboard(value)
                } label: {
                    Label(label.map { "Copy \($0)" } ?? "Copy", systemImage: "doc.on.doc")
                }

                if let label, !label.isEmpty, label != value {
                    Button {
                        copyToClipboard("\(label): \(value)")
                    } label: {
                        Label("Copy Both", systemImage: "doc.on.doc.fill")
                    }
                }
            }
    }

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
        Haptics.tap()
    }
}

public extension View {
    /// Enables iOS Settings-style long-press to copy on any view or row.
    ///
    /// Pressing and holding on the view displays the native context menu with
    /// a "Copy" action that puts `value` on the system clipboard and triggers haptics.
    func copyableValue(_ value: String, label: String? = nil) -> some View {
        modifier(CopyableValueModifier(value: value, label: label))
    }

    /// Convenience modifier for `LabeledContent` or key-value rows where both label and value are provided.
    func copyableRow(label: String, value: String) -> some View {
        modifier(CopyableValueModifier(value: value, label: label))
    }
}

/// A native iOS Settings-styled LabeledContent row with built-in long-press copy support.
public struct CopyableLabeledContent<Content: View>: View {
    private let label: String
    private let valueString: String
    private let customContent: Content?

    public init(_ label: String, value: String) where Content == Text {
        self.label = label
        self.valueString = value
        self.customContent = nil
    }

    public init(_ label: String, valueString: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.valueString = valueString
        self.customContent = content()
    }

    public var body: some View {
        Group {
            if let customContent {
                LabeledContent(label) {
                    customContent
                }
            } else {
                LabeledContent(label, value: valueString)
            }
        }
        .copyableValue(valueString, label: label)
    }
}
