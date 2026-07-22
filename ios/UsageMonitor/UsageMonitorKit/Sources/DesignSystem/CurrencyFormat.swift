import Foundation

/// Currency / percent formatting shared by the app and the widget so both
/// render money identically. USD is the monitor's canonical reporting
/// currency (see budget-status.ts — non-USD is excluded from budget math).
public enum CurrencyFormat {
    /// `$1,234.56` — full precision, for detail surfaces.
    public static func usd(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// Compact money for tiles/widgets: `$1.2K`, `$948`, `$4.16`.
    ///
    /// The compact-name branch is hand-rolled rather than using
    /// Kept deterministic instead of relying on locale-dependent compact-name
    /// output. This produces stable `$1.2K` / `$3.4M` / `$1.1B` shapes.
    public static func compactUSD(_ value: Double) -> String {
        let magnitude = abs(value)
        if magnitude >= 1_000 {
            let sign = value < 0 ? "-" : ""
            let scaled: Double
            let suffix: String
            switch magnitude {
            case 1_000_000_000...:
                scaled = value / 1_000_000_000
                suffix = "B"
            case 1_000_000...:
                scaled = value / 1_000_000
                suffix = "M"
            default:
                scaled = value / 1_000
                suffix = "K"
            }
            let number = abs(scaled).formatted(.number.precision(.fractionLength(0...1)))
            return "\(sign)$\(number)\(suffix)"
        }
        if magnitude >= 100 {
            return value.formatted(.currency(code: "USD").precision(.fractionLength(0)))
        }
        return value.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// `48%` from a 0...1 ratio. Clamps nothing — callers decide.
    public static func percent(_ ratio: Double) -> String {
        ratio.formatted(.percent.precision(.fractionLength(0)))
    }
}
