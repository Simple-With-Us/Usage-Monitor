# Browser-extension credential-scraping containment (2026-07-18)

Seat: CLAUDE. Branch: `claude/extension-containment` off `origin/main` `80d79e5`.
Lane: owner-directed urgent security containment of the shipped `chrome-extension/`.

## What was wrong (v1.0.0, on `origin/main`)

`chrome-extension/` shipped a credential-scraping design:

- `manifest.json` granted `<all_urls>` host access plus `scripting` + `activeTab`,
  and registered content scripts on `console.anthropic.com` and
  `platform.openai.com`.
- `scripts/anthropic.js` and `scripts/openai.js` ran ~3s after page load and read
  `document.cookie` (session tokens) **and the entire page `localStorage`**, then
  messaged them to the background worker.
- `scripts/background.js` POSTed the scraped values — together with a monitor
  bearer token persisted in `chrome.storage.local` — to `${apiUrl}/api/ingest/keys`.
- That endpoint **does not exist** in the backend (only `/api/ingest/usage` does),
  so nothing was ever received server-side, but the local scraping ran
  automatically and the destination host was whatever the user (or a bad config)
  set, i.e. a live client-side exfiltration path.

## What changed

- Deleted `scripts/anthropic.js`, `scripts/openai.js`, `scripts/background.js`.
- Rewrote `manifest.json` to a least-privilege launcher: `permissions: ["storage"]`
  only — no `host_permissions`, no `content_scripts`, no `background`, no
  `scripting`/`activeTab`. Bumped to `2.0.0`.
- Rewrote the popup to store only a non-secret Dashboard URL (validated to
  `http(s)` origins, blocking `javascript:`/`data:`) and open it with
  `chrome.tabs.create` (needs no extra permission). No token field, no `fetch`.
- Rewrote `README.md` with an honest security notice and rotation guidance for
  anyone who ran v1.0.0.
- Added `src/__tests__/chrome-extension-safety.test.ts` locking in the invariants
  (no `<all_urls>`, no content scripts, no background worker, storage-only perms,
  scraper files absent, and no `document.cookie`/`localStorage`/`/api/ingest/keys`/
  `SYNC_KEYS` in executable source).

### Safari

The Safari Xcode project references the shared `chrome-extension/` folder
(`manifest.json`, `popup/`, `scripts/`) as build resources for **both** the
macOS and iOS extension targets
(`safari-extension/.../project.pbxproj`). So the Safari build packages the *same*
`chrome-extension/` payload — it was **not** a hollow wrapper, and the vulnerable
v1.0.0 manifest/scripts shipped there too. Sanitizing `chrome-extension/`
therefore remediates Safari as well; both now build from the clean shared source.
Safari carries no scraper of its own — its only script,
`Shared (App)/Resources/Script.js`, is Apple's app-UI boilerplate.

Cosmetic follow-up: the pbxproj still lists the now-removed
`chrome-extension/scripts/` folder (and an `icons/` folder that never existed) as
resource references, which produces a harmless Xcode "missing file" warning. The
`.pbxproj` was left untouched here to avoid risking the Xcode project; the
stale references can be pruned in a separate Safari-only change.

## Scope / safety

Client-side extension files + one test + docs only. No backend, provider,
adapter, schema, secret, DNS, scheduler, or Render/Oracle change. Opened as a PR
and held — no merge/deploy during the active Oracle release freeze.
