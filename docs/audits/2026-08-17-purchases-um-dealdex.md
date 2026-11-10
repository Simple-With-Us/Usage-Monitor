# Purchase-path scan — Usage-Monitor + DealDex

**Date:** 2026-08-17  
**Seat:** CURSOR (Grok 4.6 cloud)  
**Method:** Read-only.  No product-code edits.  No Stripe or StoreKit transactions.  Usage-Monitor scanned at `8db78b58`.  DealDex scanned at `fb6f7b2d` on `jaywedgeworth22/DealDex` `main` via authenticated GitHub API (private clone URL 404'd from this VM; contents API succeeded).

## Verdict

| App | Live web Stripe checkout / portal / webhook | Native iOS StoreKit / IAP | App Review 3.1.1 (no Stripe digital-goods buy-in-app) | End-to-end purchase audit |
|---|---|---|---|---|
| **Usage-Monitor** (web + Client + Local) | **Absent** | **Absent** | **Pass by absence** | **N/A — no path to audit** |
| **DealDex** (web + iOS + Android) | **Absent** | **Absent** | **Pass by absence** | **N/A — no path to audit** |

**Fix PRs needed: none.**  Do not invent a checkout, Customer Portal, webhook, or IAP lane for either app.

## Keepout

Already-claimed 2026-08-17 UM report-only PRs (not duplicated):

| PR | Branch | Lane |
|---|---|---|
| #1234 | `cursor/providers-accuracy-audit-9579` | Stripe **as a poll adapter** (fee/balance truth) |
| #1235 | `cursor/security-privacy-audit-f36a` | Secrets / receipt privacy |
| #1236 | `cursor/blind-spots-audit-60bb` | Residual domains |
| #1237 | `cursor/web-ios-parity-audit-fc87` | Client vs Local vs web UX; TestFlight 1.0.0 EULA reject |
| #1238 | `cursor/outcomes-projections-audit-4269` | Burn / projection math |
| #1239 | `cursor/backend-durability-audit-c46b` | SQLite / backups / jobs |
| #1233 | `grok/board-hygiene-2026-08-17` | Effort-board hygiene |

DealDex open work is Grok store-submit / Vercel / board hygiene (issues #57/#60/#73).  Those are ASC app-record and host linking, not a purchase implementation.  Congress.Trade Monet Apple IAP + Stripe Premium (`CT` #1553/#1558/#1560) is a **different app** and is out of scope.

No open UM or DealDex issue/PR implements or claims a sell-side Stripe or StoreKit path.

---

## Usage-Monitor — evidence of absence

This app **monitors** other vendors' bills.  It does not sell Usage Monitor itself.

### No sell-side Stripe

| Check | Result |
|---|---|
| `stripe` npm package | Not in `package.json` |
| `checkout.sessions` / `billingPortal` / `PaymentIntent` / `constructEvent` / `STRIPE_WEBHOOK` / `STRIPE_PRICE` / `STRIPE_PUBLISHABLE` | Zero matches in `*.{ts,tsx,js,jsx,swift,mjs}` |
| `src/app/api/**/route.ts` | 33 routes.  None are `/api/stripe`, `/api/checkout`, `/api/billing`, or `/api/webhooks` |
| `src/middleware.ts` public paths | Login, ingest, OTLP, health, platforms, subscriptions **read**, legal pages.  No checkout or webhook exclusion |

What **does** exist (look-alikes, not a store):

1. **Poll adapter** `src/lib/adapters/stripe.ts` — `GET /v1/balance` + paginated `/v1/balance_transactions`.  Records month-to-date **processing fees**.  Explicitly `stripeAccountSubscription: false` with note *"Customer subscriptions are merchant revenue, not the Stripe account's own plan."*
2. **Platforms probe** `src/lib/platform-status/probes/payments.ts` — `GET /v1/account` only.  File header: *"status check rather than a revenue report"* and *".env.example" asks for a restricted **read** key (`rk_live_...`) with Account read — never a write `sk_live_`.*
3. **Infisical map** `STRIPE_SECRET_KEY` → provider name `stripe` for Congress.Trade fee monitoring (`src/lib/infisical-provider-sync.ts`).
4. **Owner Subscription CRUD** `/api/subscriptions` — materializes **the operator's** recurring vendor fees into `ExternalUsageEvent`.  `activationMode: "repurchase"` re-anchors an already-paid Cloudflare/etc. term.  It does not charge a customer card.
5. **Receipt import** (`import:billing-receipts`, Apple receipt scripts, receipt-inbox Worker) — inbound evidence of **already-paid** vendor charges.  The Worker never holds `BILLING_RECEIPT_INGEST_TOKEN` and cannot create cost events from email.

### No native IAP

| Check | Result |
|---|---|
| `import StoreKit` / `StoreKit2` / `SKPayment` / `Product.purchase` / `Transaction.currentEntitlements` / `AppStore.sync` | Zero matches under `ios/` |
| RevenueCat / Superwall / Adapty / `purchases-ios` | Absent |
| Client entitlements `ios/UsageMonitor/App/Resources/UsageMonitor.entitlements` | App Group + `aps-environment` only |
| Local entitlements `LocalApp/Resources/LocalUsageMonitor.entitlements` | App Group only |
| `ios/UsageMonitor/project.yml` | No IAP capability.  Category `public.app-category.developer-tools` |
| `UsageMonitorKit/Package.swift` | No StoreKit product |

`SubscriptionManagementInventory.swift` talks to `/api/subscriptions` (vendor fee rows).  Privacy (`src/app/privacy/page.tsx`) states there is **no App Store account system** and the apps do not sell personal data.  Support page has no upgrade/pay CTA.

**App Review:** Guideline 3.1.1 cannot fail for Stripe-in-iOS digital goods because neither iOS app offers a purchase.  Residual TestFlight issues (EULA / Invalid Binary) belong to #1237 / Grok ship lanes, not this scan.

---

## DealDex — evidence of absence

DealDex is a Pokémon listing desk.  Users paste **their own** marketplace/valuation keys.  The product does not sell DealDex Premium or unlock desks with money.

### No sell-side Stripe

| Check | Result |
|---|---|
| `stripe` / RevenueCat / IAP deps in `package.json` | Absent (Better Auth, Vite, TanStack, PGLite/pg) |
| GitHub code search `stripe`, `StoreKit`, `IAP`, `SKPayment`, `webhook`, `billingPortal`, `PaymentIntent`, `purchase` | No product hits.  "checkout" is **git** checkout / `actions/checkout` only |
| HTTP API surface | `/api/auth/$`, `/api/native/session` (email sign-in/up), `/api/native/keys` (optional key backup).  No checkout, portal, or webhook route |
| Open PRs / issues matching stripe/checkout/StoreKit/IAP/purchase/billing | None |

`PaidDesks.swift` / `PaidDesks.kt` call JustTCG, PriceCharting, and pokemontcg.io **from the phone** with keys the user pasted.  Comment: *"Calls paid valuation APIs directly from the phone. Never goes through DealDex.com."*  "Paid" means those vendors' APIs, not an in-app SKU.

### No native IAP

| Check | Result |
|---|---|
| `native/ios/project.yml` | App target only.  No entitlements file.  No IAP capability |
| `native/ios/DealDex/Info.plist` | Shopping category, ATS deny-arbitrary, export-compliance false.  No StoreKit keys |
| iOS Settings | Origin URL, optional email/password, three desk key fields.  No Upgrade / Subscribe / Restore |
| Android `AndroidManifest.xml` | `INTERNET` + `POST_NOTIFICATIONS` only.  No `com.android.vending.BILLING` |
| `docs/store-listing.md` review notes | *"No account is required.  Paste optional API keys in Settings.  Sign-in is only for backing up those keys."* |
| `src/routes/privacy.tsx` | Device keys + optional account backup.  No payments section |
| `PLAN.md` "Out of scope until asked" | Fleet/host/ASC.  No monetization item |

Grok #56 / issue #60 prepared TestFlight listing copy.  Blocker is an ASC **app record** (`me.grok.dealdex`), not IAP product setup.

**App Review:** Same 3.1.1 pass-by-absence.  Native apps do not wrap a web Stripe checkout.  Do not add one on iOS later without StoreKit.

---

## What this is not

| Look-alike | Why it is not a purchase path |
|---|---|
| UM Stripe adapter + Platforms Stripe card | Read-only monitoring of the **operator's** Stripe account fees/status |
| UM `Subscription` / iOS subscription settings | Operator-entered vendor recurrences (Cloudflare Workers Paid, etc.) |
| UM Apple receipt import | Bookkeeping of Apple-billed **vendor** charges (Claude Max, etc.) |
| DealDex "paid desks" | User-owned third-party API keys |
| DealDex "checkout" in docs/CI | Git checkout |
| CT Stripe + Apple IAP Premium | Congress.Trade only |

## Recommended follow-ups

None for purchase correctness.  If a later seat adds sell-side billing:

1. Web: Checkout Session + webhook signature verify + Customer Portal; never charge from the iOS binary.
2. iOS digital goods / unlocks: StoreKit 2 + App Store Server Notifications only (see CT Monet lessons; do not copy the pre-#1560 unverified confirm path).
3. Do not dual-offer Stripe and IAP for the same digital unlock inside the iOS app.

Until someone asks for that product, leave both codebases as they are.
