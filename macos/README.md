# Usage Monitor for macOS

> **Note:** The macOS application has been extracted into its own repository and renamed to **AgentBar**.
>
> Please visit [jaywedgeworth22/agent-bar](https://github.com/jaywedgeworth22/agent-bar) for the current application source code, build scripts, and documentation.

The `macos` directory in this repository is kept for historical reference.  The Keychain-prompt fix below still applies to this copy and should be mirrored into AgentBar.

The app supports menu bar, Dock, or both surfaces.  Both is the default.  The server read token is stored in macOS Keychain, scoped to its endpoint URL.  The endpoint and display preferences are stored in UserDefaults.  Local CLI credentials are read in memory and are never copied into the app's preferences or logs.

Quota refreshes run every five minutes, on wake, and on demand.  Readings older than 30 minutes are stale.  A passed reset time means awaiting refresh; it never restores a cap without a new reading.  Missing percentages remain unknown.  Absolute request/credit caps are shown only when the provider explicitly reports them.  No quota is inferred from token spend, plan prices, or normalized percentages.

Closing the main window keeps the app running.  Open it again from its menu bar panel or Dock icon.  Settings → Show In changes the mode immediately.  Quit from the app menu or the menu bar panel's More menu.  There is no LaunchAgent or login item.

Keyboard shortcuts: ⌘1 opens the dashboard, ⌘2 opens Quick Quotas, ⌘R refreshes, and ⌘, opens Settings.

Antigravity displays exactly four shared windows: Gemini and Third-Party, each with a 5-Hour and weekly cap.  Repeated model observations are not additional quotas.  Missing weekly data stays unavailable with no invented reset.  Kimi, Gemini CLI, GitHub Copilot, and Windsurf are hidden, including when the server returns them.  DeepSeek and future supported platforms can be supplied by the server.  MiniMax video allowances are collapsed below its coding windows and do not drive the menu bar percentage.  Expired local sessions require signing in again in the provider's app or CLI.

Antigravity's grouped source requires a running Antigravity app or CLI that exposes `RetrieveUserQuotaSummary`.  If no compatible process is running, the installed `antigravity-usage` helper can supply only the 5-hour windows.  Claude reads an existing OAuth credential file automatically.  For a Keychain login, use Settings → Connect Claude once per app session.  That explicit action may show macOS permission UI; its result stays only in memory.  Startup, wake, and quota refreshes never query Keychain.  Missing access does not mean Claude is signed out.  The optional server token likewise loads only from an explicit Save & Refresh action; reconnect it after restarting the app.  Local and server windows are never combined within a provider because they may belong to different accounts.

Grok Bot uses Cursor's separate `GetSandUsageStatus` weekly allowance, with its own card and reset time.  It never inherits Cursor's monthly usage or Grok CLI's subscription meter.  A rejected session or unreported included allowance stays unavailable.

For BotFleet on the same Mac, the app atomically publishes a credential-free, mode-0600 snapshot at `~/Library/Application Support/Usage Monitor/quota-windows.json`.  Only local readings are shared.  BotFleet accepts supported provider windows observed within ten minutes, keeps provider accounts separate from its remote server, and excludes Grok Bot.  The handoff updates the quota display; it does not itself change BotFleet routing cooldowns.  Disabling local readings removes the snapshot.

Platform logos are the existing BotFleet SVG assets; Cursor uses BotFleet's existing PNG where no SVG is available.

From the repository root:

```sh
swift test --package-path macos
./script/build_and_run.sh --build-only
./script/build_and_run.sh
./script/build_and_run.sh --verify
./script/build_and_run.sh --install
```

`--build-only` stages and ad hoc signs `macos/dist/Usage Monitor.app` without terminating or launching an app.  The default command terminates only the staged app executable, then builds and opens the bundle.  `--install` copies only over an existing bundle with identifier `com.simplewithus.usage.macos` (or the pre-2026-09-23 `com.jays.usage-monitor.mac`, so an older install upgrades in place); it refuses any other bundle.  The app shows as **Usage Monitor for Mac** (`CFBundleDisplayName`); the bundle folder stays `Usage Monitor.app`.  The Keychain service string `com.jays.usage-monitor.mac.read-token` in `TokenStore.swift` is an internal namespace, not a bundle ID, and is unchanged.

Local builds use ad hoc signing for development.  This repository does not claim notarized distribution.
