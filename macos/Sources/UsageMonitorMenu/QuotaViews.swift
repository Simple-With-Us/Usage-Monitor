import AppKit
import QuotaCore
import SwiftUI

private enum Palette {
    static let ink = Color(red: 0.12, green: 0.17, blue: 0.23)
    static let accent = Color(red: 0.03, green: 0.45, blue: 0.43)
    static let background = Color(red: 0.96, green: 0.97, blue: 0.97)
    static let warning = Color(red: 0.66, green: 0.36, blue: 0.02)
    static let danger = Color(red: 0.75, green: 0.20, blue: 0.23)
}

struct MonitorDashboard: View {
    @ObservedObject var model: MonitorModel
    var openSettings: () -> Void
    @State private var selected = "all"
    @State private var query = ""

    private var visibleSections: [QuotaPlatformSection] {
        model.sections.filter { section in
            (selected == "all" || selected == section.providerKey)
                && (query.isEmpty || section.providerLabel.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        summary
                        if let error = model.serverError {
                            Label("Server: \(error)  Local readings remain available.", systemImage: "exclamationmark.triangle")
                                .font(.callout).foregroundStyle(Palette.warning)
                        }
                        if let error = model.handoffError {
                            Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Palette.warning)
                        }
                        if !model.localEnabled && !model.serverEnabled {
                            ContentUnavailableView("Connect a Quota Source", systemImage: "link",
                                                   description: Text("Enable local agent readings or connect your Usage Monitor server in Settings."))
                        }
                        HStack {
                            Text(selected == "all" ? "Subscription Quotas" : visibleSections.first?.providerLabel ?? "Subscription Quotas")
                                .font(.title3.bold())
                            Spacer()
                            Text("Percent remaining").font(.caption).foregroundStyle(.secondary)
                        }
                        if model.viewLayout == .allAtOnce && selected == "all" {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), alignment: .top)], alignment: .leading, spacing: 12) {
                                ForEach(visibleSections, id: \.providerKey) { section in
                                    CompactDashboardPlatformCard(section: section, now: model.now, issue: model.issues[section.providerKey])
                                }
                            }
                        } else {
                            LazyVGrid(columns: selected == "all" ? [GridItem(.adaptive(minimum: 290), alignment: .top)] : [GridItem(.flexible())], alignment: .leading, spacing: 16) {
                                ForEach(visibleSections, id: \.providerKey) { section in
                                    PlatformCard(section: section, now: model.now, issue: model.issues[section.providerKey], compact: false, wide: selected != "all")
                                }
                            }
                        }
                        if selected == "google-antigravity" {
                            Text("Models used through Antigravity share its subscription quotas.")
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(26)
                }
                .background(Palette.background)
                .id(selected + query)
            }
        }
        .foregroundStyle(Palette.ink)
        .tint(Palette.accent)
        .preferredColorScheme(.light)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 9) {
                Image(systemName: "gauge.with.dots.needle.50percent").font(.title2).foregroundStyle(Palette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage Monitor").font(.headline)
                    Text("AGENT SUBSCRIPTIONS").font(.system(size: 8, weight: .semibold, design: .rounded)).tracking(1.1).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, 16).padding(.top, 24)
            List(selection: $selected) {
                Label("All Platforms", systemImage: "square.grid.2x2").tag("all")
                Section("Platforms") {
                    ForEach(model.sections, id: \.providerKey) { section in
                        HStack(spacing: 8) {
                            PlatformLogo(providerKey: section.providerKey, size: 17)
                            Text(section.providerLabel)
                            Spacer()
                            if section.providerKey != "google-antigravity", model.issues[section.providerKey] == nil, let remaining = section.windows.filter({ $0.isFresh && !$0.window.isSupplementaryVideoQuota }).compactMap(\.remainingPercent).min() {
                                Text("\(Int(remaining.rounded()))%").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }.tag(section.providerKey)
                    }
                }
            }.listStyle(.sidebar).scrollContentBackground(.hidden)
            VStack(alignment: .leading, spacing: 10) {
                Label(model.localEnabled ? "Local Mac readings" : "Local readings off", systemImage: "desktopcomputer")
                    .font(.caption).foregroundStyle(.secondary)
                Button {
                    NSWorkspace.shared.open(URL(string: "https://usage.jays.services")!)
                } label: { Label("Web Dashboard", systemImage: "arrow.up.right.square") }
                    .buttonStyle(.plain).font(.caption)
                Button(action: openSettings) { Label("Settings", systemImage: "gearshape") }
                    .buttonStyle(.plain)
            }.padding(18)
        }
        .frame(width: 208)
        .background(Color.white)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Agent Quotas").font(.system(size: 26, weight: .bold, design: .rounded))
                Text("Your subscriptions, at a glance.").font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("Layout", selection: $model.viewLayout) {
                ForEach(QuotaViewLayout.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 170)
            TextField("Find a platform", text: $query).textFieldStyle(.roundedBorder).frame(width: 145)
                .accessibilityLabel("Find a platform")
            Button { model.refresh() } label: {
                Label(model.isRefreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
            }.disabled(model.isRefreshing)
        }.padding(22).background(Color.white)
    }

    private var summary: some View {
        HStack(spacing: 12) {
            SummaryTile(label: "Reporting", value: "\(model.reportingCount) / \(model.sections.count)", symbol: "antenna.radiowaves.left.and.right", detail: "Platforms with current readings")
            SummaryTile(label: "Near Cap", value: "\(model.nearCapCount)", symbol: "gauge.with.dots.needle.100percent", detail: "Windows at 20% or less")
            SummaryTile(label: "Next Reset", value: model.nextReset.map { $0.formatted(date: .omitted, time: .shortened) } ?? "—", symbol: "clock", detail: model.nextReset.map { $0.formatted(.dateTime.month(.abbreviated).day()) } ?? "No current reset reported")
        }
    }
}

private struct SummaryTile: View {
    let label: String
    let value: String
    let symbol: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(label, systemImage: symbol).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 25, weight: .semibold, design: .rounded)).monospacedDigit()
            Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
        .padding(16).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.black.opacity(0.06)))
    }
}

struct PlatformCard: View {
    let section: QuotaPlatformSection
    let now: Date
    let issue: String?
    let compact: Bool
    var wide = false
    @State private var expanded = false
    @State private var videoExpanded = false

    private var primaryWindows: [QuotaWindowSnapshot] {
        section.windows.filter { !$0.window.isSupplementaryVideoQuota }
    }
    private var videoWindows: [QuotaWindowSnapshot] {
        section.windows.filter { $0.window.isSupplementaryVideoQuota }
    }
    private var displayedWindows: [QuotaWindowSnapshot] {
        expanded ? primaryWindows : Array(primaryWindows.prefix(4))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 16) {
            HStack(spacing: 10) {
                PlatformLogo(providerKey: section.providerKey, size: compact ? 25 : 32)
                    .frame(width: compact ? 28 : 36, height: compact ? 28 : 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.providerLabel).font(.headline)
                    if section.via == "antigravity" {
                        Text("Antigravity subscription").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !section.windows.isEmpty {
                    Text(issue == nil && section.hasFreshReport ? "LIVE" : "LAST REPORT")
                        .font(.system(size: 8, weight: .bold)).tracking(0.7)
                        .foregroundStyle(issue == nil && section.hasFreshReport ? Palette.accent : Palette.warning)
                }
            }
            if section.windows.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Quota unavailable").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                    Text(issue ?? "No subscription quota source connected.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if wide && displayedWindows.count > 1 {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 22) {
                        ForEach(displayedWindows, id: \.window.id) { snapshot in
                            QuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil, compact: compact)
                                .padding(12)
                                .background(Palette.background, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                } else {
                    ForEach(Array(displayedWindows.enumerated()), id: \.offset) { index, snapshot in
                        if index > 0 { Divider() }
                        QuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil, compact: compact)
                    }
                }
                if primaryWindows.count > 4 {
                    Button(expanded ? "Show Less" : "Show All \(primaryWindows.count) Windows") { expanded.toggle() }
                        .buttonStyle(.plain).font(.caption.weight(.medium)).foregroundStyle(Palette.accent)
                }
                if !videoWindows.isEmpty {
                    Divider()
                    DisclosureGroup(isExpanded: $videoExpanded) {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(videoWindows, id: \.window.id) { snapshot in
                                QuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil, compact: true)
                            }
                        }.padding(.top, 8)
                    } label: {
                        Label("Video · \(videoWindows.count) windows", systemImage: "video")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let issue {
                    Label(issue, systemImage: "exclamationmark.circle")
                        .font(.caption).foregroundStyle(Palette.warning).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(compact ? 14 : 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.black.opacity(0.07)))
    }


}

private struct QuotaRow: View {
    let snapshot: QuotaWindowSnapshot
    let now: Date
    let sourceFailed: Bool
    let compact: Bool
    private var tint: Color {
        if !snapshot.isFresh || sourceFailed || snapshot.remainingPercent == nil { return .secondary }
        if snapshot.status == .exhausted { return Palette.danger }
        if (snapshot.remainingPercent ?? 100) <= 20 { return Palette.warning }
        return Palette.accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(snapshot.window.label).font(.system(size: compact ? 11 : 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 10)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(snapshot.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—")
                        .font(.system(size: compact ? 18 : 24, weight: .semibold, design: .rounded))
                        .monospacedDigit().foregroundStyle(tint)
                    Text(snapshot.remainingPercent == nil ? "unavailable" : snapshot.isFresh && !sourceFailed ? "remaining" : "last reported")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
            }
            if let remaining = snapshot.remainingPercent {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.black.opacity(0.06))
                        Capsule().fill(tint).frame(width: geometry.size.width * remaining / 100)
                    }
                }.frame(height: 5)
                .accessibilityLabel("\(Int(remaining.rounded())) percent remaining")
            }
            if let remaining = snapshot.window.absoluteRemaining, let limit = snapshot.window.absoluteLimit,
               remaining.isFinite, limit.isFinite, remaining >= 0, limit > 0, let unit = snapshot.window.quotaUnit {
                Text("\(remaining.formatted(.number.precision(.fractionLength(0...1)))) of \(limit.formatted(.number.precision(.fractionLength(0...1)))) \(unit) remaining")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Image(systemName: "clock.arrow.circlepath").accessibilityHidden(true)
                Text(resetCountdown(snapshot.resetAt, now: now))
            }.font(.caption2).foregroundStyle(.secondary)
            if let reset = snapshot.resetAt, !compact {
                Text(reset.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute().timeZone()))
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
            if !compact {
                HStack {
                    Text(snapshot.observedAt.map { "Updated \($0.formatted(date: .omitted, time: .shortened))" } ?? "Update time unavailable")
                    Spacer()
                    if snapshot.observedAt == nil { Text("Not reported") }
                    else if snapshot.isStale { Text("Stale").foregroundStyle(Palette.warning) }
                    else if let source = snapshot.window.source { Text(source).lineLimit(1) }
                }.font(.system(size: 9)).foregroundStyle(.tertiary)
            }
        }.accessibilityElement(children: .combine)
    }
}

struct QuotaPopover: View {
    @ObservedObject var model: MonitorModel
    var openMonitor: () -> Void
    var openSettings: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage Monitor").font(.headline)
                    Text("\(model.reportingCount) platforms reporting").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("Layout", selection: $model.viewLayout) {
                    ForEach(QuotaViewLayout.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 145)
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.isRefreshing).help("Refresh Quotas").accessibilityLabel("Refresh Quotas")
                Button(action: openSettings) { Image(systemName: "gearshape") }.help("Settings").accessibilityLabel("Settings")
            }.padding(14)
            Divider()
            ScrollView {
                VStack(spacing: 8) {
                    if model.isRefreshing { ProgressView("Refreshing quotas…").font(.caption).padding(4) }
                    if let error = model.serverError { Text(error).font(.caption).foregroundStyle(Palette.warning) }
                    if model.viewLayout == .allAtOnce {
                        ForEach(model.sections.sorted { !$0.windows.isEmpty && $1.windows.isEmpty }, id: \.providerKey) { section in
                            CompactPopoverPlatformRow(section: section, now: model.now, issue: model.issues[section.providerKey])
                        }
                    } else {
                        ForEach(model.sections.sorted { !$0.windows.isEmpty && $1.windows.isEmpty }, id: \.providerKey) { section in
                            PlatformCard(section: section, now: model.now, issue: model.issues[section.providerKey], compact: true)
                        }
                    }
                }.padding(10)
            }.background(Palette.background)
            Divider()
            HStack {
                Button("Open Monitor", action: openMonitor).buttonStyle(.borderedProminent)
                Spacer()
                Menu {
                    Picker("Show In", selection: $model.displayMode) {
                        ForEach(DisplayMode.allCases) { Text($0.title).tag($0) }
                    }
                    Divider()
                    Button("Quit Usage Monitor") { NSApp.terminate(nil) }
                } label: { Image(systemName: "ellipsis.circle") }.menuStyle(.borderlessButton).frame(width: 24)
            }.padding(12)
        }
        .frame(width: 410, height: 600)
        .tint(Palette.accent).preferredColorScheme(.light)
    }
}

private func quotaStatusColor(for snapshot: QuotaWindowSnapshot, sourceFailed: Bool) -> Color {
    if !snapshot.isFresh || sourceFailed || snapshot.remainingPercent == nil { return .secondary }
    if snapshot.status == .exhausted { return Palette.danger }
    if (snapshot.remainingPercent ?? 100) <= 20 { return Palette.warning }
    return Palette.accent
}

private func compactWindowName(_ label: String) -> String {
    let lower = label.lowercased()
    if lower.contains("5-hour") || lower.contains("5 hour") { return "5h" }
    if lower.contains("7-day") || lower.contains("7 day") { return "7d" }
    if lower.contains("weekly") { return "Weekly" }
    if lower.contains("daily") { return "Daily" }
    if lower.contains("fast request") { return "Fast" }
    if lower.contains("slow request") { return "Slow" }
    if lower.contains("session") { return "Session" }
    if lower.contains("claude 3.5") || lower.contains("sonnet") { return "Sonnet" }
    if lower.contains("gemini pro") || lower.contains("pro") { return "Pro" }
    if lower.contains("flash") { return "Flash" }
    if lower.contains("opus") { return "Opus" }
    return label.components(separatedBy: " ").first ?? label
}

private func compactResetCountdown(_ reset: Date?, now: Date) -> String {
    guard let reset else { return "" }
    let seconds = reset.timeIntervalSince(now)
    guard seconds > 0 else { return "⟳" }
    let minutes = max(1, Int(ceil(seconds / 60)))
    if minutes >= 1440 { return "\(minutes / 1440)d" }
    if minutes >= 60 { return "\(minutes / 60)h" }
    return "\(minutes)m"
}

struct CompactPopoverPlatformRow: View {
    let section: QuotaPlatformSection
    let now: Date
    let issue: String?

    private var primaryWindows: [QuotaWindowSnapshot] {
        section.windows.filter { !$0.window.isSupplementaryVideoQuota }
    }

    var body: some View {
        HStack(spacing: 8) {
            PlatformLogo(providerKey: section.providerKey, size: 20)
                .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(section.providerLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                if section.via == "antigravity" {
                    Text("Antigravity")
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 88, alignment: .leading)

            Spacer(minLength: 2)

            if primaryWindows.isEmpty {
                Text(issue ?? "Unavailable")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                HStack(spacing: 6) {
                    ForEach(Array(primaryWindows.prefix(3)), id: \.window.id) { snapshot in
                        CompactPopoverQuotaPill(snapshot: snapshot, now: now, sourceFailed: issue != nil)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.black.opacity(0.06)))
    }
}

private struct CompactPopoverQuotaPill: View {
    let snapshot: QuotaWindowSnapshot
    let now: Date
    let sourceFailed: Bool

    private var color: Color {
        quotaStatusColor(for: snapshot, sourceFailed: sourceFailed)
    }

    private var resetCountdownText: String? {
        guard let reset = snapshot.resetAt else { return nil }
        let text = compactResetCountdown(reset, now: now)
        return text.isEmpty ? nil : text
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 3) {
                Text(compactWindowName(snapshot.window.label))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)

                Text(snapshot.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(color)

                if let resetText = resetCountdownText {
                    Text(resetText)
                        .font(.system(size: 8))
                        .foregroundStyle(.secondary)
                }
            }

            if let pct = snapshot.remainingPercent {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.black.opacity(0.08))
                    Capsule().fill(color).frame(width: 44 * CGFloat(min(max(pct, 0), 100)) / 100)
                }
                .frame(width: 44, height: 3)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
    }
}

struct CompactDashboardPlatformCard: View {
    let section: QuotaPlatformSection
    let now: Date
    let issue: String?

    private var primaryWindows: [QuotaWindowSnapshot] {
        section.windows.filter { !$0.window.isSupplementaryVideoQuota }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                PlatformLogo(providerKey: section.providerKey, size: 22)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 1) {
                    Text(section.providerLabel)
                        .font(.system(size: 13, weight: .bold))
                        .lineLimit(1)
                    if section.via == "antigravity" {
                        Text("Antigravity subscription").font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !section.windows.isEmpty {
                    Text(issue == nil && section.hasFreshReport ? "LIVE" : "LAST REPORT")
                        .font(.system(size: 8, weight: .bold)).tracking(0.6)
                        .foregroundStyle(issue == nil && section.hasFreshReport ? Palette.accent : Palette.warning)
                }
            }

            if primaryWindows.isEmpty {
                Text(issue ?? "Quota unavailable")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(primaryWindows.prefix(3)), id: \.window.id) { snapshot in
                        CompactDashboardQuotaRow(snapshot: snapshot, now: now, sourceFailed: issue != nil)
                    }
                }
            }
        }
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.black.opacity(0.06)))
    }
}

private struct CompactDashboardQuotaRow: View {
    let snapshot: QuotaWindowSnapshot
    let now: Date
    let sourceFailed: Bool

    private var color: Color {
        quotaStatusColor(for: snapshot, sourceFailed: sourceFailed)
    }

    var body: some View {
        VStack(spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(snapshot.window.label)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(snapshot.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "—")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(color)
            }
            if let pct = snapshot.remainingPercent {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.black.opacity(0.07))
                        Capsule().fill(color).frame(width: geo.size.width * CGFloat(min(max(pct, 0), 100)) / 100)
                    }
                }
                .frame(height: 3)
            }
            HStack {
                if let reset = snapshot.resetAt {
                    Text(resetCountdown(reset, now: now))
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let remaining = snapshot.window.absoluteRemaining, let limit = snapshot.window.absoluteLimit,
                   remaining.isFinite, limit.isFinite, remaining >= 0, limit > 0, let unit = snapshot.window.quotaUnit {
                    Text("\(remaining.formatted(.number.precision(.fractionLength(0...1)))) / \(limit.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}

struct MonitorSettings: View {
    @ObservedObject var model: MonitorModel
    @State private var local = true
    @State private var server = false
    @State private var endpoint = ""
    @State private var token = ""
    @State private var message: String?
    @State private var isError = false
    @State private var saving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Usage Monitor Settings").font(.title2.bold())
            GroupBox("Automatic Updates") {
                HStack {
                    Text(AppUpdater.shared.availability.summary)
                    Spacer()
                    Button("Check For Updates…") { AppUpdater.shared.checkForUpdates() }
                        .disabled(!AppUpdater.shared.canCheckForUpdates)
                }.padding(10)
            }
            GroupBox("Appearance") {
                Picker("Show In", selection: $model.displayMode) {
                    ForEach(DisplayMode.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).padding(10)
            }
            GroupBox("Quota Sources") {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Read Agent Quotas on This Mac", isOn: $local)
                    Text("Uses existing Claude, Codex, Antigravity, Cursor, Grok CLI, Grok Bot, and MiniMax sign-ins.  Shares local quota readings with BotFleet.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button(model.connectingClaude ? "Connecting Claude…" : "Connect Claude") {
                            Task { await model.connectClaude() }
                        }.disabled(model.connectingClaude || !local)
                        if model.connectingClaude { ProgressView().controlSize(.small) }
                    }
                    Text(model.claudeConnectionMessage ?? "Connect once per app session to access Claude’s existing Keychain login.  macOS may ask for permission; quota refreshes never do.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Divider()
                    Toggle("Connect Usage Monitor Server", isOn: $server)
                    TextField("Quota Endpoint", text: $endpoint).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Quota Endpoint").disabled(!server)
                    SecureField(model.hasSavedToken ? "Token saved · enter to replace" : "Usage Monitor read token", text: $token)
                        .textFieldStyle(.roundedBorder).disabled(!server).accessibilityLabel("Usage Monitor read token")
                    Text("The read token stays in Keychain.  Use Save & Refresh once per app session to connect it.  Quotas refresh every 5 minutes without Keychain access.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(10)
            }
            if let message {
                Text(message).font(.caption).foregroundStyle(isError ? Palette.danger : Palette.accent)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                if model.hasSavedToken {
                    Button("Forget Server Token", role: .destructive) {
                        saving = true
                        Task {
                            defer { saving = false }
                            do { try await model.forgetServer(); server = false; token = ""; message = "Server token removed."; isError = false }
                            catch { message = error.localizedDescription; isError = true }
                        }
                    }
                }
                Spacer()
                Button("Save & Refresh") {
                    saving = true
                    Task {
                        defer { saving = false }
                        do {
                            try await model.saveConnection(local: local, server: server, endpoint: endpoint, token: token)
                            token = ""; message = "Settings saved."; isError = false
                        } catch { message = error.localizedDescription; isError = true }
                    }
                }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
            if saving { ProgressView("Saving settings…").font(.caption) }
            Spacer(minLength: 0)
        }
        .disabled(saving || model.connectingClaude)
        .padding(24).frame(width: 580, height: 610).tint(Palette.accent).preferredColorScheme(.light)
        .onAppear { local = model.localEnabled; server = model.serverEnabled; endpoint = model.endpoint }
    }
}
