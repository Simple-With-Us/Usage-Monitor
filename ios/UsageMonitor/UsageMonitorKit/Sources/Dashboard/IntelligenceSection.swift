import SwiftUI
import DesignSystem
import Models
import AppCore

struct IntelligenceSection: View {
    @Bindable var store: IntelligenceStore
    var onOpenSettings: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Intelligence")

            if store.requiresSession {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Full Dashboard Access Required")
                        .font(Theme.Typography.callout.weight(.semibold))
                    Text("Sign in with the dashboard password in Settings to load LLM burn, Claude cost check, and key attribution.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    if let onOpenSettings {
                        Button("Open Settings", action: onOpenSettings)
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.Colors.accent)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .dsCard()
            } else {
                if let burn = store.burn, burn.ok, burn.hasActivity {
                    LlmBurnCard(response: burn)
                } else if store.burnState.isLoading {
                    SkeletonBlock(height: 100, radius: Theme.Radius.lg)
                }

                if let claude = store.claudeCost, claude.ok, claude.hasData {
                    ClaudeCostLiteCard(response: claude)
                }

                if let keys = store.keyAttribution {
                    KeyAttributionLiteCard(response: keys)
                }
            }
        }
    }
}

struct LlmBurnCard: View {
    let response: LlmBurnResponse

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("LLM Burn")
                .font(Theme.Typography.sectionHeader)
            Text("Trailing window — analytics only, not cash.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            ForEach(response.providers.prefix(6)) { row in
                HStack {
                    Text(row.provider)
                        .font(Theme.Typography.callout.weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        if let usd = row.window.estimateUsd ?? row.window.derivedCostUsd ?? row.window.reportedCostUsd {
                            Text(usd, format: .currency(code: "USD"))
                                .font(Theme.Typography.captionEmphasis)
                                .monospacedDigit()
                        }
                        Text("\(Int(row.window.tokens.total)) tok")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

struct ClaudeCostLiteCard: View {
    let response: ClaudeCostCheckResponse

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Claude Cost Check")
                .font(Theme.Typography.sectionHeader)
            Text("OTLP cost vs LiteLLM derivation (analytics).")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            if let reported = response.totalReportedCostUsd, let derived = response.totalDerivedCostUsd {
                HStack {
                    Text("Reported \(reported, format: .currency(code: "USD"))")
                    Spacer()
                    Text("Derived \(derived, format: .currency(code: "USD"))")
                }
                .font(Theme.Typography.captionEmphasis)
                .monospacedDigit()
            }
            ForEach((response.models ?? []).prefix(4)) { row in
                HStack {
                    Text(row.model).lineLimit(1)
                    Spacer()
                    if row.unpriced == true {
                        Text("unpriced").foregroundStyle(Theme.Colors.warning)
                    } else if let drift = row.driftRatio {
                        Text(String(format: "%.0f%% drift", abs(drift) * 100))
                            .foregroundStyle(abs(drift) >= 0.15 ? Theme.Colors.danger : Theme.Colors.secondaryText)
                    }
                }
                .font(Theme.Typography.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

struct KeyAttributionLiteCard: View {
    let response: KeyAttributionResponse

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Key Attribution")
                .font(Theme.Typography.sectionHeader)
            if let s = response.summary {
                Text("\(s.matchedIdentities ?? 0) matched · \(s.unattributedKeys ?? 0) unattributed")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach((response.identities ?? []).prefix(5)) { id in
                HStack {
                    Text(id.displayName ?? id.id).lineLimit(1)
                    Spacer()
                    if let project = id.projectName {
                        Text(project)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .font(Theme.Typography.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}
