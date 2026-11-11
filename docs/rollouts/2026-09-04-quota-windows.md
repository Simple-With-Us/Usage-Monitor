# 2026-09-04 — Quota windows API + antigravity-usage per-model remaining

**Why:** Owner wants onWatch-class remaining percent in Usage Monitor, and
BotFleet needs a machine-readable skip list so it does not use a model that
is already exhausted.

**Do not:** vendor GPL onWatch, reinstall EasyCLIProxyAPI as a live proxy, or
scrape consumer OAuth from Coolify.  LiteLLM 1.99.0 is installed and idle; it
only meters traffic routed through its proxy and does not read Claude / Codex /
Antigravity subscription 5h/7d remaining.  EasyCLIProxyAPI leftovers were not
found; do not reinstall it (it intercepts CLIs).  `.gitleaksignore` ignores
one fingerprint from the first quota-routing commit: `generic-api-key` matched
`seriesKey` plus a model id in collector tests.  HEAD already splits that
string.  The ignore file is only so PR history does not fail Security.

**What landed**

- `GET /api/quota-windows` (session cookie or `USAGE_READ_TOKEN`).  Latest
  `metricType=quota` events folded by series.  `skip` is true only when
  remaining is 0 or `isExhausted`.  Near-cap (≤20%) is a display status.
- Mac collector still runs `agy -p /usage` for group × window (5h / weekly).
  When `antigravity-usage` is on PATH it also posts per-model remaining,
  `resetTime`, and `isExhausted`.
- Fleet Quota Matrix no longer invents demo buckets.

**BotFleet sibling:** polls this URL for non-Antigravity engines.  Antigravity
reads `antigravity-usage` locally every minute.

**Board:** `109294fe`.  **Issue:** #1411.
