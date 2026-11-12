import AppKit
import Combine
import SwiftUI

@main
enum UsageMonitorMain {
    @MainActor
    static func main() {
        // Current ID first; the pre-2026-09-23 ID still matches an older build
        // that is already running.
        let bundleIdentifiers = ["com.simplewithus.usage.macos", "com.jays.usage-monitor.mac"]
        if let existing = bundleIdentifiers
            .flatMap({ NSRunningApplication.runningApplications(withBundleIdentifier: $0) })
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }) {
            existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            return
        }
        // Must run before AppDelegate creates MonitorModel, which reads these keys.
        LegacyDefaultsMigration.run()
        let app = NSApplication.shared
        app.disableRelaunchOnLogin()
        NSWindow.allowsAutomaticWindowTabbing = false
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

/// #1525 moved the bundle ID from com.jays.usage-monitor.mac to
/// com.simplewithus.usage.macos, which moves UserDefaults.standard to a new
/// domain. Copy the settings MonitorModel reads from the legacy domain once.
/// Values already set under the new ID always win, and the legacy domain is
/// left in place. Reading another app's domain works because this app is not
/// sandboxed (script-built, ad-hoc signed, no entitlements).
enum LegacyDefaultsMigration {
    static let legacyDomain = "com.jays.usage-monitor.mac"
    static let markerKey = "migratedFromLegacyBundleID"
    static let keys = ["displayMode", "quotaViewLayout", "localEnabled", "serverEnabled", "endpoint", "hasSavedToken"]

    static func run(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: markerKey) else { return }
        copy(from: defaults.persistentDomain(forName: legacyDomain) ?? [:], into: defaults)
        defaults.set(true, forKey: markerKey)
    }

    static func copy(from legacy: [String: Any], into defaults: UserDefaults) {
        for key in keys where defaults.object(forKey: key) == nil {
            if let value = legacy[key] { defaults.set(value, forKey: key) }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = MonitorModel()
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var monitorWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var subscriptions = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .aqua)
        configureMenu()
        AppUpdater.shared.start()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 410, height: 600)
        popover.contentViewController = NSHostingController(rootView:
            QuotaPopover(model: model, openMonitor: { [weak self] in self?.showMonitor() },
                         openSettings: { [weak self] in self?.showSettings() }))
        model.$displayMode.removeDuplicates().sink { [weak self] mode in
            self?.apply(mode)
        }.store(in: &subscriptions)
        model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.updateStatus() }
        }.store(in: &subscriptions)
        if model.displayMode != .menuBar { showMonitor() }
        model.start()
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(refresh), name: NSWorkspace.didWakeNotification, object: nil)
    }

    func applicationWillTerminate(_ notification: Notification) { model.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMonitor()
        return true
    }

    private func apply(_ mode: DisplayMode) {
        // AppKit owns only activation and status-item lifetime; content remains SwiftUI.
        if mode != .dock && statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self
            item.button?.action = #selector(togglePopover)
            item.button?.image = NSImage(systemSymbolName: "gauge.with.dots.needle.50percent", accessibilityDescription: "Usage Monitor")
            item.button?.image?.isTemplate = true
            item.button?.imagePosition = .imageLeading
            statusItem = item
        }
        NSApp.setActivationPolicy(mode == .menuBar ? .accessory : .regular)
        if mode == .menuBar { monitorWindow?.orderOut(nil) }
        if mode == .dock {
            popover.performClose(nil)
            if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
            statusItem = nil
            showMonitor()
        }
        updateStatus()
    }

    private func updateStatus() {
        statusItem?.button?.title = " " + model.menuBarTitle
        statusItem?.button?.toolTip = "Usage Monitor · " + model.menuBarDetail
        statusItem?.button?.setAccessibilityLabel("Usage Monitor, " + model.menuBarDetail)
    }

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { showMonitor(); return }
        if popover.isShown { popover.performClose(nil) }
        else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    @objc func showMonitor() {
        popover.performClose(nil)
        if monitorWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 740),
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered, defer: false)
            window.title = "Usage Monitor"
            window.minSize = NSSize(width: 800, height: 540)
            window.isReleasedWhenClosed = false
            window.isRestorable = false
            window.delegate = self
            window.contentView = NSHostingView(rootView:
                MonitorDashboard(model: model, openSettings: { [weak self] in self?.showSettings() }))
            window.setFrameAutosaveName("UsageMonitorMainWindow")
            window.center()
            monitorWindow = window
        }
        monitorWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func showSettings() {
        popover.performClose(nil)
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 510),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Usage Monitor Settings"
            window.isReleasedWhenClosed = false
            window.isRestorable = false
            window.contentView = NSHostingView(rootView: MonitorSettings(model: model))
            window.center()
            settingsWindow = window
        }
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func refresh() { model.refresh() }
    @objc private func checkForUpdates() { AppUpdater.shared.checkForUpdates() }
    @objc private func quit() { NSApp.terminate(nil) }

    private func configureMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        func add(_ title: String, _ action: Selector, _ key: String = "") {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self
            appMenu.addItem(item)
        }
        add("Open Usage Monitor", #selector(showMonitor), "1")
        add("Quick Quotas", #selector(togglePopover), "2")
        add("Settings…", #selector(showSettings), ",")
        add("Refresh Quotas", #selector(refresh), "r")
        add("Check For Updates…", #selector(checkForUpdates))
        appMenu.addItem(.separator())
        add("Quit Usage Monitor", #selector(quit), "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        editItem.title = "Edit"
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }
}
