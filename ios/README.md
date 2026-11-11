# Usage Monitor — iOS apps

Two App Store products that share kit code but **not** money-truth or identity.

| App (user-visible name) | Scheme | Bundle ID | Purpose |
|---|---|---|---|
| **Usage Monitor Client** | `UsageMonitor` | `com.simplewithus.usage.client.ios` | Live-sync **client** of a Usage Monitor **server** you host (or the owner fleet). Widget: `com.simplewithus.usage.client.widget`. |
| **Usage Monitor Local** | `LocalUsageMonitor` | `com.simplewithus.usage.local.ios` | **Free App Store candidate** — on-device only. Keys in Keychain; budgets in local SQLite. **No server required.** |

User-facing copy uses the **plain app name** only. Show `name` + `bundle ID` together only on identity/debug surfaces.

Design authority: [`docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md`](../docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md).  
Binding contract: [`UsageMonitor/ARCHITECTURE-CONTRACT.md`](UsageMonitor/ARCHITECTURE-CONTRACT.md).

### Product identity (do not swap)

| | Usage Monitor Client | Usage Monitor Local |
|---|---|---|
| Bundle ID | `com.simplewithus.usage.client.ios` | `com.simplewithus.usage.local.ios` |
| App group | `group.com.simplewithus.usage` | `group.com.simplewithus.usage` |
| Deep link | `usageclientmonitor://` | `usagelocalmonitor://` |
| ASC name | Usage Monitor Client | Usage Monitor Local |
| ASC SKU | `usage-client-monitor` | `usage-local-monitor` |
| TestFlight ship | `bash scripts/ios-ship-testflight.sh` | `bash scripts/ios-ship-testflight-local.sh` |

Never reuse one app’s bundle ID for the other (App Store Connect, TestFlight, and device installs must stay separate).

## Which one should I use?

- Server + live sync → **Usage Monitor Client** (self-host the free server code, then point the app at your URL)
- Phone is the whole product / free public App Store → **Usage Monitor Local**

They do **not** share an app group, Keychain, or database.

## Generate & build

```bash
cd ios/UsageMonitor
xcodegen generate
xcodebuild -scheme UsageMonitor -destination 'generic/platform=iOS Simulator' build
xcodebuild -scheme LocalUsageMonitor -destination 'generic/platform=iOS Simulator' build
```

## Installing both on one phone

| Scheme | Bundle ID | Home-screen name |
|---|---|---|
| `UsageMonitor` | `com.simplewithus.usage.client.ios` | Usage Monitor |
| `LocalUsageMonitor` | `com.simplewithus.usage.local.ios` | Local Monitor |

1. Scheme menu → **UsageMonitor** → Run.  
2. Stop or leave running.  
3. Scheme menu → **LocalUsageMonitor** → Run.  
4. Two icons on the home screen.

Delete any old install under legacy IDs if you tested earlier:

- `services.jays.usage.monitor`
- `services.jays.usage.monitor.local`
- `services.jays.local.usage.monitor`
- `services.jays.usage.client.monitor` (pre-2026-09-22 bundle ID)
- `services.jays.usage.local.monitor` (pre-2026-09-22 bundle ID)
- `services.jays.usage.client.monitor.widget` (pre-2026-09-22 widget)
- `services.jays.usage.client.monitor.widgettests` (pre-2026-09-22 widget tests)
- `services.jays.usage.client.monitor.tests` (pre-2026-09-22 tests)
- `services.jays.usage.monitor.safari.Extension` (pre-2026-09-22 Safari extension)
- `services.jays.usage.monitor.safari` (pre-2026-09-22 Safari host app)
- `com.simplewithus.usagemonitor.ios`, `com.simplewithus.usagemonitor.local.ios` (2026-09-22 only, #1524; TestFlight builds under these IDs, if any, are separate apps)

Canonical IDs are only the **client** / **local** rows in the table above.

## TestFlight

Hosted path: `.github/workflows/ios-ship.yml` on GitHub-hosted `macos-latest`.
It imports the existing team ASC/P12 GitHub secrets and execs in-repo
`scripts/ios-fleet/`.  LocalUsageMonitor stays skipped on that workflow.

```bash
# Usage Monitor Client (server-backed) -- what hosted ios-ship runs
bash scripts/ios-ship-testflight.sh

# Usage Monitor Local (on-device only) -- not started by hosted ios-ship
bash scripts/ios-ship-testflight-local.sh
```

ASC: create apps with the **new** bundle IDs before first upload (API key cannot create apps — Account Holder / Admin in the ASC UI).

## Local provider catalog

**Usage Monitor Local** ships a fleet-aligned catalog (LLM, hosting, market data, infra).

- **Poll (API key):** OpenRouter, OpenAI org costs, DeepSeek balance, Anthropic Admin cost report
- **API vs chat split:** OpenAI (API) + ChatGPT (subscription); Anthropic (API) + Claude (subscription); xAI + SuperGrok (subscription).
- **Connection chips:** Polls Cost / Polls Balance / Recurring Fee / Optional Key / Fee Only — never raw `subscription_only`.
- **+ → Add Missing Providers** creates empty cards for every known service (no keys or fees invented).  Open a card and tap **Connect Account** to paste a key.  Fetch Usage Automatically appears only after a key is saved.  **Add Provider** on an existing card updates that card instead of erroring.
