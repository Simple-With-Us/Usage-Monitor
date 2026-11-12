import SwiftUI
import DesignSystem

/// Learn More tab for Usage Monitor Local — the on-device app.
/// Product copy only: how to read the app, where numbers come from, and links.
/// No live data, no Settings state.  UM-1363.
public struct LocalLearnMoreTab: View {
  private static let sentenceGap = "\u{00A0} "

  public init() {}

  public var body: some View {
    NavigationStack {
      List {
        sectionOverview
        sectionReadingDashboard
        sectionProviderCards
        sectionFeatures
        sectionPieces
        sectionTroubleshooting
        sectionLearnMore
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Learn More")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  // MARK: - Sections

  private var sectionOverview: some View {
    Section {
      VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
        Text(
          "This is Usage Monitor Local.\(Self.sentenceGap)It keeps spend, budgets, and API keys on this device — no hosted server required."
        )
        .font(Theme.Typography.body)
        Text(
          "It is one of three Usage Monitor pieces.\(Self.sentenceGap)The other two are the hosted dashboard and the App Store iPhone app."
        )
        .font(Theme.Typography.body)
      }
    } header: {
      Text("What This App Is")
    }
  }

  private var sectionReadingDashboard: some View {
    Section {
      VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
        Text(
          "Overview shows month-to-date spend in USD and how it compares to budgets you set.\(Self.sentenceGap)Providers is the list of vendors you track.\(Self.sentenceGap)Projects groups direct charges when you tag them.\(Self.sentenceGap)Alerts lists budget and fetch issues on this phone only."
        )
        .font(Theme.Typography.body)
      }
    } header: {
      Text("Reading the Dashboard")
    }
  }

  private var sectionProviderCards: some View {
    Section {
      featureRow(
        icon: "dollarsign.circle",
        title: "Month-To-Date Spend",
        detail:
          "What this provider has cost since the start of the calendar month, including recurring fees you entered."
      )
      featureRow(
        icon: "gauge.with.dots.needle.67percent",
        title: "Budget pacing",
        detail:
          "How spend lines up with the monthly cap you chose.\(Self.sentenceGap)Yellow or red means you are close to or over budget."
      )
      featureRow(
        icon: "clock.arrow.circlepath",
        title: "Last checked",
        detail:
          "When this app last asked the provider for fresh usage.\(Self.sentenceGap)Pull to refresh on Providers to check again."
      )
      featureRow(
        icon: "key.fill",
        title: "Keys",
        detail:
          "Management-style keys can return dollars; inference-only keys may connect but show no cost.\(Self.sentenceGap)Keys stay in this device's Keychain."
      )
    } header: {
      Text("Provider Cards")
    } footer: {
      Text(
        "Some providers only support a monthly fee on the phone because their billing API needs the full server app.\(Self.sentenceGap)That is normal — enter the plan in Providers or Settings."
      )
    }
  }

  private var sectionFeatures: some View {
    Section {
      featureRow(
        icon: "chart.pie.fill",
        title: "Month-To-Date Spend",
        detail: "One USD total across connected providers and subscriptions, with budget pacing."
      )
      featureRow(
        icon: "calendar",
        title: "Recurring Fees",
        detail: "Adds each subscription's period charge so it counts in the same month-to-date total."
      )
      featureRow(
        icon: "square.and.arrow.down",
        title: "Local Backup",
        detail: "Export cards, budgets, and fees as a JSON file (not API keys) and restore them on a new device."
      )
      featureRow(
        icon: "faceid",
        title: "App Lock",
        detail: "Optional Face ID or passcode before the dashboard opens."
      )
      featureRow(
        icon: "icloud.slash.fill",
        title: "No Server Required",
        detail:
          "Saved cards and budgets are viewable offline.\(Self.sentenceGap)Checking a provider for fresh usage still needs the internet."
      )
    } header: {
      Text("Features")
    } footer: {
      Text("Cards read from the on-device database.\(Self.sentenceGap)Provider API keys stay in iOS Keychain on this device.")
    }
  }

  private var sectionPieces: some View {
    Section {
      VStack(alignment: .leading, spacing: Theme.Spacing.md) {
        fleetRow(
          icon: "iphone",
          color: Color(red: 0.05, green: 0.72, blue: 0.68),
          title: "Usage Monitor Local (This App)",
          detail: "On this device.\(Self.sentenceGap)Spend and keys stay here."
        )
        fleetRow(
          icon: "globe",
          color: Color.blue,
          title: "usage.jays.services",
          detail:
            "Hosted dashboard for the full picture in a browser, including subscription quotas and linked-app usage."
        )
        fleetRow(
          icon: "applelogo",
          color: Color.indigo,
          title: "Usage Monitor Client (iPhone)",
          detail:
            "App Store app.\(Self.sentenceGap)Syncs live with the hosted dashboard, with optional full-access management."
        )
        Text(
          "The hosted dashboard collects usage from your cloud accounts and linked apps.\(Self.sentenceGap)The iPhone client mirrors that dashboard.\(Self.sentenceGap)This local app polls each supported provider directly and lets you track fee-only subscriptions manually — it does not need the hosted dashboard to be up."
        )
        .font(Theme.Typography.caption)
        .foregroundStyle(Theme.Colors.secondaryText)
      }
    } header: {
      Text("The Three Pieces")
    }
  }

  private var sectionTroubleshooting: some View {
    Section {
      featureRow(
        icon: "exclamationmark.triangle",
        title: "No spend showing",
        detail:
          "Try a billing-capable API key, or add the plan as a recurring fee if the vendor does not expose cost on the phone."
      )
      featureRow(
        icon: "arrow.clockwise",
        title: "Numbers look stale",
        detail: "Open Providers and pull to refresh, or check your network connection."
      )
      featureRow(
        icon: "bell.badge",
        title: "Alerts",
        detail:
          "Budget overruns and poll errors appear under Alerts.\(Self.sentenceGap)They are calculated on this device only."
      )
    } header: {
      Text("When Something Looks Wrong")
    }
  }

  private var sectionLearnMore: some View {
    Section {
      linkRow(
        icon: "globe",
        title: "Dashboard",
        detail: "usage.jays.services",
        url: "https://usage.jays.services"
      )
      linkRow(
        icon: "arrow.down.app",
        title: "iPhone App",
        detail: "Usage Monitor Client on the App Store",
        url: "https://apps.apple.com/app/id6820881005"
      )
      linkRow(
        icon: "envelope",
        title: "Support",
        detail: "usage.jays.services/support",
        url: "https://usage.jays.services/support"
      )
    } header: {
      Text("Links")
    }
  }

  // MARK: - Reusable rows

  private func featureRow(icon: String, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: Theme.Spacing.md) {
      Image(systemName: icon)
        .font(.title3)
        .foregroundStyle(Theme.Colors.accent)
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(Theme.Typography.callout.weight(.semibold))
        Text(detail)
          .font(Theme.Typography.caption)
          .foregroundStyle(Theme.Colors.secondaryText)
      }
    }
    .padding(.vertical, 2)
  }

  private func fleetRow(icon: String, color: Color, title: String, detail: String) -> some View {
    HStack(alignment: .top, spacing: Theme.Spacing.md) {
      Image(systemName: icon)
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 32, height: 32)
        .background(color, in: RoundedRectangle(cornerRadius: 8))
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(Theme.Typography.callout.weight(.semibold))
        Text(detail)
          .font(Theme.Typography.caption)
          .foregroundStyle(Theme.Colors.secondaryText)
      }
    }
  }

  private func linkRow(icon: String, title: String, detail: String, url: String) -> some View {
    Link(destination: URL(string: url) ?? URL(string: "https://usage.jays.services")!) {
      HStack(spacing: Theme.Spacing.md) {
        Image(systemName: icon)
          .font(.title3)
          .foregroundStyle(Theme.Colors.accent)
          .frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(Theme.Typography.callout.weight(.semibold))
            .foregroundStyle(Theme.Colors.primaryText)
          Text(detail)
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.Colors.secondaryText)
        }
        Spacer()
        Image(systemName: "arrow.up.right.square")
          .foregroundStyle(Theme.Colors.secondaryText)
      }
    }
  }
}
