# App Store Connect listing pack — Usage Monitor iOS

**Date:** 2026-08-10  
**Team:** CC8UTF7ATG (Jay Wedgeworth, LLC)  
**Apps:** Usage Client Monitor · Usage Local Monitor  

The retired `services.jays.usage.*` ASC records have version **1.0** in `PREPARE_FOR_SUBMISSION` and VALID TestFlight builds; the renamed apps need new records (see the 2026-09-23 note). This pack is the copy, privacy answers, review notes, and screenshot plan agents/humans paste into ASC (or push via `scripts/asc-push-listing.rb`).

> **2026-10-11 identifier note (supersedes the 2026-09-23 and 2026-09-22 notes):**  The apps now use `com.simplewithus.usage.client.ios` (home-screen name Usage Monitor) and `com.simplewithus.usage.local.ios` (Local Monitor), App Group `group.com.simplewithus.usage`.  The owner ruled the trailing `.ios` wins because that is what the live App Store Connect records actually carry, and an ASC record's bundle ID cannot be changed — so the apps align to the records.  New records were created: app `6820881005` (client) and `6820885210` (local).  The IDs in this pack that begin `6799230435` / `6799230729` belong to the retired `services.jays.usage.*` bundle IDs and must not be reused.  The version / localization / app-info IDs below are not yet known; `scripts/asc-push-listing.rb` does not discover them, so fill each one in from the new records in ASC before running it, or the script refuses to push.  The listing copy (names, text, privacy answers) is unchanged and still applies.  See `docs/rollouts/2026-09-23-usage-identifier-fixes.md`.

Public legal URLs (must stay unauthenticated):

| Purpose | URL |
|--------|-----|
| Privacy Policy | https://usage.jays.services/privacy |
| Support | https://usage.jays.services/support |
| Marketing (optional) | https://usage.jays.services |

Contact (review): Jay Wedgeworth · mail@jays.services · +1 956-420-0244

---

## Shared

| Field | Value |
|------|--------|
| Primary category | Developer Tools |
| Secondary (optional) | Productivity or Finance |
| Price | Free |
| Invalid Binary note | See `docs/rollouts/2026-08-11-local-invalid-binary.md` — TF VALID ≠ App Store review; beta macOS host is likely remaining blocker |
| Content rights | Does not contain, show, or access third-party content that requires special licensing beyond user-configured APIs |
| App Groups (Local) | `group.com.simplewithus.usage` — must appear on **App Store** provisioning profile (not empty `[]`) |
| App Groups (Client) | `group.com.simplewithus.usage` on app + widget App Store profiles (single App Group shared across Client + Local + widget) |
| PrivacyInfo | Bundle `PrivacyInfo.xcprivacy` in app (+ widget). Required-reason: file timestamp `C617.1`, disk space `E174.1` |
| Export compliance | Uses only exempt encryption (HTTPS / Keychain / CryptoKit standard). `ITSAppUsesNonExemptEncryption = false` |
| Age rating | 4+ — all questionnaire items None / No (no UGC, no unrestricted web browser, no gambling, etc.) |
| App Privacy (nutrition) | See per-app sections. No tracking. |

---

## 1) Usage Client Monitor

| | |
|--|--|
| **ASC name** | Usage Client Monitor |
| **Bundle ID** | `com.simplewithus.usage.client.ios` |
| **SKU** | `usage-client-monitor` |
| **ASC app id** | `6820881005` (was retired: `6799230435`) |
| **Version id (1.0)** | pending new record (retired: `4dd15570-c956-4895-93f3-d3e7adc21080`) |
| **en-US localization id** | pending new record (retired: `806f8051-efc5-4edf-8527-3ccbdcdb79a3`) |
| **App info localization** | pending new record (retired: `d9a5a612-f7e9-459b-9fe9-3a89afb19a98`) |
| **Subtitle** (≤30) | Live budgets for API spend |
| **Promotional text** (≤170, editable without new binary) | Connect your self-hosted Usage Monitor server.  See month-to-date spend, provider budgets, project allocation, and alerts — with Face ID lock and offline widgets. |

### Description

```
Usage Client Monitor is the iOS companion for a Usage Monitor server you host.

See month-to-date API spend, budgets, and alerts without living in a browser tab.  Point the app at your server URL, store a read token in the Keychain, and keep budgets on your Lock Screen and Home Screen widgets.

WHAT IT DOES
• Live Overview — spent this month, budget pace, and projected end-of-month
• Providers — per-provider spend, budgets, and detail history
• Project budgets — allocate cost across the work that matters
• Alerts — budget warnings and exceedances, with optional local notifications
• Face ID / passcode lock so money figures stay private on a shared device
• Offline cache + widgets after the first successful sync

WHO IT IS FOR
Operators who already run (or will run) Usage Monitor on their own infrastructure — including the open/self-host path documented with the project.  This app is a client.  It does not replace hosting the server.

WHAT YOU NEED
• A reachable Usage Monitor base URL (HTTPS)
• A read or full-access token issued by that server

Privacy-minded: the developer does not receive your traffic unless you choose a server they operate.  Your token stays in the device Keychain.

Not a brokerage, bank, or tax product — developer tooling for API cost visibility.
```

### Keywords (≤100 chars, comma-separated, no spaces after commas preferred)

```
api,budget,cost,usage,openai,anthropic,llm,devops,monitor,self-host,spend
```

### What's New (1.0)

```
Initial App Store release of Usage Client Monitor — live budgets, providers, project allocation, alerts, Face ID lock, and widgets for your self-hosted Usage Monitor server.
```

### App Review notes

```
This is a client for a self-hosted Usage Monitor server (developer tools).

No public demo account is required for binary smoke checks: launch shows Settings connection fields when no token is stored.

To exercise live data (optional):
1. Set Base URL to the reviewer’s own Usage Monitor instance, OR
2. Contact mail@jays.services for a short-lived read-only review host if needed.

Face ID is optional (Settings → App Lock).  Disable App Lock for review if preferred.

Encryption: standard HTTPS + Keychain only; ITSAppUsesNonExemptEncryption is false.
```

### Privacy nutrition (Client)

| Category | Collected? | Linked to identity? | Tracking? | Notes |
|----------|------------|---------------------|-----------|-------|
| Contact Info | No (in-app) | — | No | Support via email only |
| Financial Info | Yes (usage $ from *user's* server) | No app account | No | Processed on device after fetch; not sold |
| Sensitive Info / credentials | Token in Keychain | No | No | User-supplied server token |
| Identifiers | No advertising ID | — | No | |
| Usage Data | No analytics SDK | — | No | |
| Diagnostics | No third-party crash SDK in app | — | No | |

Declare data types only if the app *by design* sends them off-device: budget JSON goes to **user-configured** server host. If ASC requires “sent off device”, classify as Financial Info / Other User Content to **app functionality** with “not linked / not used for tracking”, purpose App Functionality.

---

## 2) Usage Local Monitor

| | |
|--|--|
| **ASC name** | Usage Local Monitor |
| **Bundle ID** | `com.simplewithus.usage.local.ios` |
| **SKU** | `usage-local-monitor` |
| **ASC app id** | `6820885210` (was retired: `6799230729`) |
| **Version id (1.0)** | pending new record (retired: `7ddabffc-9fbd-413d-addd-34476fa5cefd`) |
| **en-US localization id** | pending new record (retired: `09c8eb6b-8f6d-4629-b14b-6e30a5d73da6`) |
| **App info localization** | pending new record (retired: `2d225776-d637-483e-aa1a-690f4b40e3fb`) |
| **Subtitle** (≤30) | On-device API budget tracker |
| **Promotional text** | Track OpenRouter, OpenAI, Anthropic, and more on your phone — keys in Keychain, budgets in on-device SQLite.  No Usage Monitor server required. |

### Description

```
Usage Local Monitor keeps API and subscription spend visible on your iPhone — entirely on-device.

Add the providers you already pay for, store keys in the Keychain, and see month-to-date cost, budgets, renewals, and alerts without running a separate server.

WHAT IT DOES
• On-device Overview — spent this month, budget remaining, projected end-of-month
• Provider catalog aligned with real developer stacks (LLM, hosting, data, infra)
• Poll adapters where providers expose cost or balance APIs (for example OpenRouter, OpenAI org costs, Anthropic Admin cost report, DeepSeek balance)
• Recurring fees as subscriptions that materialize into the same spend totals
• Projects — optional budgets for each effort
• Export / import packages (keys never included in exports)
• Face ID / passcode lock
• Wipe local data when you want a clean slate

WHO IT IS FOR
Individual developers and small teams who want phone-first cost awareness without hosting Usage Monitor.

WHAT IT IS NOT
• Not a remote dashboard client (that is Usage Client Monitor)
• Not a bank, brokerage, or tax product
• Does not invent spend for providers that only offer console billing — those stay as subscription or manual rows

Privacy-minded: processing is on-device.  Keys leave the device only over HTTPS to providers you choose.
```

### Keywords

```
api,budget,cost,openai,anthropic,openrouter,llm,local,on-device,usage,spend
```

### What's New (1.0)

```
Initial App Store release of Usage Local Monitor — on-device budgets, provider catalog, poll adapters, subscriptions, projects, export/import, and Face ID lock. No server required.
```

### App Review notes

```
On-device developer tools app.  No login and no developer-operated backend.

First launch seeds an empty/local catalog.  To see non-zero month-to-date cost:
1. Add Provider → choose OpenRouter (or similar)
2. Paste a management/provisioning key if the provider requires it for cost APIs
3. Pull to refresh

Inference-only keys may show connected without MTD cost — expected.

Optional: use Settings wipe to clear demo data.

Face ID is optional.  Encryption is standard HTTPS + Keychain only.

Screenshot builds may use -ScreenshotDemo fixture data; production App Store binaries do not require that flag.
```

### Privacy nutrition (Local)

| Category | Collected by developer? | Notes |
|----------|-------------------------|-------|
| Financial Info | Processed on device; not transmitted to developer | User’s provider cost figures |
| Sensitive Info | Keys in Keychain; sent only to user-chosen providers | |
| Tracking | No | |
| Analytics / Ads | No | |
| Contact Info | No in-app collection | |

App Privacy form: typically **Data Not Collected** *by the developer* if no developer backend receives data. Disclose that the app contacts third-party APIs the user configures (purpose: App Functionality). Prefer accurate “data not collected [by us]” when no developer endpoint is involved.

---

## Screenshot plan

Required for modern iPhone submission (portrait):

| Display type | Device used | Size (px) |
|--------------|-------------|-----------|
| `APP_IPHONE_67` | iPhone 16 Pro Max / 15 Pro Max class | 1320×2868 or 1290×2796 |
| `APP_IPAD_PRO_3GEN_129` (iPad supported) | iPad Pro 13-inch | 2048×2732 |

Capture **5** frames per app (same story, distinct chrome):

1. **Overview** — hero spend + budget meter  
2. **Providers** — list with status badges  
3. **Provider / detail or Projects** — depth  
4. **Alerts** — warning/exceeded rows  
5. **Settings** — lock + identity (Local: on-device banner; Client: connection)

Capture command:

```bash
bash scripts/ios-asc-screenshots.sh
```

Upload:

```bash
ruby scripts/asc-push-listing.rb --all
ruby scripts/asc-push-screenshots.rb --all
```

Demo launch args (simulator only; not for shipping):

```
-ScreenshotDemo -ScreenshotTab dashboard   # Client
-ScreenshotDemo -ScreenshotTab overview    # Local
```

---

## Submission checklist

- [ ] Privacy + support pages live unauthenticated  
- [ ] en-US name, subtitle, description, keywords, URLs set  
- [ ] Age rating all None  
- [ ] Primary category Developer Tools  
- [ ] Screenshots uploaded for iPhone 6.7" (+ iPad if required)  
- [ ] Build selected on version 1.0  
- [ ] Review contact + notes  
- [ ] App Privacy answers saved  
- [ ] Submit for Review (owner deliberate step if not auto-submitted)

Fleet note: public App Store release is intentional — after this pack is complete, `Submit for Review` is the final gate.
