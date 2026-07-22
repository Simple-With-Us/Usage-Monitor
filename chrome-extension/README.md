# Usage Monitor Launcher (browser extension)

A minimal, least-privilege browser extension that opens your self-hosted
Usage Monitor dashboard in a new tab. It stores only the dashboard URL you type
in. **It reads no page content, cookies, `localStorage`, or credentials from any
site, and it transmits nothing to any endpoint.**

## Installation (Unpacked)

1. Open Google Chrome.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the `chrome-extension/` directory inside your `Usage-Monitor` repository.

## Configuration & use

1. Click the **Usage Monitor** icon in your toolbar.
2. Enter your **Dashboard URL** (e.g. `http://localhost:4103` for local dev, or
   your hosted URL such as `https://usage.jays.services`).
3. Click **Save URL** to remember it, **Open Dashboard** to open it now, or
   **Open iPhone/iPad App** to follow the app's `usagemonitor://dashboard` link.

Remote dashboard URLs must use HTTPS. Plain HTTP is accepted only for loopback
development (`localhost`, `127.0.0.1`, or `::1`).

No token is required or accepted — the extension only opens the dashboard, where
you authenticate normally.

## Permissions

- `storage` — to remember the non-secret dashboard URL between sessions.

That is the extension's entire permission footprint: no host permissions, no
content scripts, no `scripting`/`activeTab`, and no background worker.

## Safari (macOS and iOS)

`safari-extension/Usage Monitor Safari/Usage Monitor Safari.xcodeproj` is the
universal Safari wrapper. Its iOS and macOS extension targets reference this
same reviewed `manifest.json` and popup directly, so the Safari build cannot
silently drift back to the removed scraper payload. Open the project in Xcode,
select the iOS or macOS app scheme, and Archive with the configured team.

## Security notice — behavior change in v2.0.0

Earlier builds (v1.0.0) of this extension were **unsafe and have been removed**.
That version:

- requested the `<all_urls>` host permission,
- injected content scripts into `console.anthropic.com` and
  `platform.openai.com` that automatically read your session cookies and the
  entire page `localStorage` a few seconds after load, and
- POSTed those values, together with a stored monitor bearer token, to a
  `/api/ingest/keys` endpoint (which never existed in the Usage Monitor backend).

None of that scraping or transmission code remains. If you ever loaded the v1.0.0
build:

1. Remove/reload the extension so the old content scripts stop running.
2. As a precaution, sign out and back in (or rotate the session) on any
   Anthropic or OpenAI dashboard you visited while it was installed, since those
   session identifiers were read locally by the old content scripts.

There is no server-side `/api/ingest/keys` route, so no scraped data was ever
accepted by the Usage Monitor backend; this change removes the client-side
collection path entirely.
