import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Regression guard for the browser-extension credential-scraping containment.
// v1.0.0 of chrome-extension/ scraped document.cookie + full localStorage from
// provider dashboards and POSTed them (with a stored monitor token) to a
// nonexistent /api/ingest/keys endpoint under an <all_urls> grant. That exact
// payload was removed once, then re-merged via a "restore extension" PR, so this
// test exists to make any reintroduction fail CI. Because the Safari Xcode
// project bundles the reviewed manifest and popup from chrome-extension/,
// keeping this folder clean also keeps the Safari build clean.

const repoRoot = process.cwd();
const extDir = path.join(repoRoot, "chrome-extension");
const safariDir = path.join(repoRoot, "safari-extension");
const manifestPath = path.join(extDir, "manifest.json");

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

// Concatenate the EXECUTABLE surface (any script/markup/config), not prose.
// The README legitimately documents the removed behavior, so *.md is excluded.
function collectSource(rootDir: string): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(m?js|cjs|ts|jsx|tsx|html|json|swift)$/.test(entry.name)) {
        chunks.push(readFileSync(p, "utf8"));
      }
    }
  };
  walk(rootDir);
  return chunks.join("\n");
}

// Signatures of credential capture / exfiltration that must never reappear in
// executable extension source (Chrome or Safari).
const EXFIL_PATTERNS: Array<[string, RegExp]> = [
  ["document.cookie read", /document\.cookie/],
  ["localStorage access", /localStorage/],
  ["sessionStorage access", /sessionStorage/],
  ["ingest-keys sink", /\/api\/ingest\/keys/],
  ["SYNC_KEYS message", /SYNC_KEYS/],
  ["message-passing worker", /chrome\.runtime\.onMessage/],
  ["stored api token", /apiToken/],
  ["network fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["bearer auth", /Bearer\s|Authorization/],
];

describe("chrome-extension credential-scraping containment", () => {
  it("requests no broad host access", () => {
    const m = readManifest();
    const hosts = (m.host_permissions as string[] | undefined) ?? [];
    expect(hosts).not.toContain("<all_urls>");
    expect(hosts).toEqual([]); // a launcher needs no host permissions at all
  });

  it("injects no content scripts", () => {
    const m = readManifest();
    expect((m.content_scripts as unknown[] | undefined) ?? []).toEqual([]);
  });

  it("runs no background service worker", () => {
    const m = readManifest();
    expect(m.background).toBeUndefined();
  });

  it("holds only least-privilege permissions", () => {
    const m = readManifest();
    const perms = (m.permissions as string[] | undefined) ?? [];
    for (const forbidden of ["scripting", "activeTab", "webRequest", "cookies", "tabs"]) {
      expect(perms).not.toContain(forbidden);
    }
    // "storage" (for the non-secret dashboard URL) is the only thing allowed.
    for (const p of perms) expect(["storage"]).toContain(p);
  });

  it("removed the scraper content scripts and exfil background worker", () => {
    for (const f of ["scripts/anthropic.js", "scripts/openai.js", "scripts/background.js"]) {
      expect(existsSync(path.join(extDir, f))).toBe(false);
    }
  });

  it("captures no credentials and exfiltrates nothing (chrome-extension)", () => {
    const src = collectSource(extDir);
    for (const [label, pattern] of EXFIL_PATTERNS) {
      expect(pattern.test(src), `chrome-extension executable source must not contain ${label}`).toBe(false);
    }
  });

  it("keeps documented IPv6 loopback development available", () => {
    const popup = readFileSync(path.join(extDir, "popup", "popup.js"), "utf8");
    expect(popup).toContain("parsed.hostname === '[::1]'");
  });

  it("Safari build resources carry no scraping payload", () => {
    // Safari's Xcode project references chrome-extension/{manifest,popup}
    // as build resources, so it inherits that executable payload. It must also carry
    // no scraper of its own (its only script is Apple's app-UI boilerplate).
    expect(existsSync(safariDir)).toBe(true);
    const src = collectSource(safariDir);
    for (const [label, pattern] of [
      ["document.cookie read", /document\.cookie/],
      ["ingest-keys sink", /\/api\/ingest\/keys/],
      ["SYNC_KEYS message", /SYNC_KEYS/],
      ["stored api token", /apiToken/],
    ] as Array<[string, RegExp]>) {
      expect(pattern.test(src), `safari-extension must not contain ${label}`).toBe(false);
    }
  });

  it("ships universal Safari targets backed by the reviewed launcher resources", () => {
    const projectPath = path.join(
      safariDir,
      "Usage Monitor Safari",
      "Usage Monitor Safari.xcodeproj",
      "project.pbxproj",
    );
    expect(existsSync(projectPath)).toBe(true);
    const project = readFileSync(projectPath, "utf8");
    expect(project).toContain("Usage Monitor Safari Extension (iOS)");
    expect(project).toContain("Usage Monitor Safari Extension (macOS)");
    expect(project).toContain("../../../chrome-extension/popup");
    expect(project).toContain("../../../chrome-extension/manifest.json");
    expect(project).not.toContain("../../../chrome-extension/README.md");
    expect(project).not.toContain("../../../chrome-extension/scripts");
    expect(project).not.toContain("../../../chrome-extension/icons");
  });
});
