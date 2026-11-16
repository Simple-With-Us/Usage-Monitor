import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("./publish-ios-versions.sh", import.meta.url).pathname;

function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", ...env },
    encoding: "utf8"
  });
}

function baseDocument() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00Z",
    apps: {
      "trade.socratic.app": { marketingVersion: "1.0.68", build: "100", appleId: 1, displayName: "Socratic.Trade" },
      "com.example.other": { marketingVersion: "2.0.0", build: "8" }
    }
  };
}

test("skip-push keeps every other app and records the new build", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-manifest-"));
  const base = join(dir, "base.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(baseDocument()));
  const result = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--build", "202611010101",
    "--apple-id", "6820881005",
    "--display-name", "Usage Monitor",
    "--base-json", base,
    "--out-json", out,
    "--skip-push",
    "--skip-local-write"
  ], { PATH: "/usr/bin:/bin" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skip-push com\.example\.usage 0\.1\.0 apps=3/);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(doc.apps["trade.socratic.app"].marketingVersion, "1.0.68");
  assert.equal(doc.apps["com.example.other"].build, "8");
  assert.equal(doc.apps["com.example.usage"].build, "202611010101");
  assert.equal(doc.apps["com.example.usage"].appleId, 6820881005);
  assert.equal(doc.schemaVersion, 1);
});

test("an already recorded version does not publish and does not need a token", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-noop-"));
  const base = join(dir, "base.json");
  const marker = join(dir, "gh-called");
  const doc = baseDocument();
  doc.apps["com.example.usage"] = { marketingVersion: "0.1.0", build: "9", appleId: 5, displayName: "Usage Monitor" };
  writeFileSync(base, JSON.stringify(doc));
  writeFileSync(join(dir, "gh"), "#!/bin/sh\ntouch \"$GH_CALLED\"\nexit 99\n");
  chmodSync(join(dir, "gh"), 0o755);
  const result = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--build", "9",
    "--apple-id", "5",
    "--display-name", "Usage Monitor",
    "--base-json", base,
    "--skip-local-write"
  ], { PATH: `${dir}:/usr/bin:/bin`, GH_CALLED: marker });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already recorded/);
  assert.equal(existsSync(marker), false);
});

test("usage errors and unsafe documents fail before any publish", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-refuse-"));
  const empty = join(dir, "empty.json");
  const out = join(dir, "out.json");
  writeFileSync(empty, JSON.stringify({ apps: {} }));
  assert.equal(run(["--version", "1"]).status, 2);
  assert.equal(run(["--bundle-id", "com.example.usage", "--version", "1", "--apple-id", "nope", "--base-json", empty, "--skip-push"]).status, 2);
  assert.equal(run(["--bundle-id", "../evil", "--version", "1", "--base-json", empty, "--skip-push"]).status, 2);
  const placeholder = run([
    "--bundle-id", "com.example.usage", "--version", "1.0 (from IPA)", "--base-json", empty, "--skip-push", "--out-json", out
  ]);
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /placeholder/);
  assert.equal(existsSync(out), false);
  const blank = run([
    "--bundle-id", "com.example.usage", "--version", "1.0.0", "--base-json", empty, "--skip-push"
  ]);
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /no apps/);
});

test("GITHUB_TOKEN alone cannot publish, and a live seed is required without --base-json", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-token-"));
  const base = join(dir, "base.json");
  writeFileSync(base, JSON.stringify(baseDocument()));
  writeFileSync(join(dir, "gh"), "#!/bin/sh\necho called >&2\nexit 99\n");
  chmodSync(join(dir, "gh"), 0o755);
  const token = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--build", "10",
    "--base-json", base,
    "--skip-local-write"
  ], { PATH: `${dir}:/usr/bin:/bin`, GITHUB_TOKEN: "workflow-token" });
  assert.equal(token.status, 1);
  assert.match(token.stderr, /GITHUB_TOKEN cannot write/);
  assert.match(token.stderr, /SWU Autofix GitHub App installation token/);
  assert.doesNotMatch(token.stderr, /GH_PAT/);
  assert.doesNotMatch(token.stderr, /called/);
  const aliased = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--build", "10",
    "--base-json", base,
    "--skip-local-write"
  ], { PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: "workflow-token", GITHUB_TOKEN: "workflow-token" });
  assert.equal(aliased.status, 1);
  assert.match(aliased.stderr, /GITHUB_TOKEN cannot write/);
  assert.doesNotMatch(aliased.stderr, /called/);

  const live = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--skip-local-write"
  ], { PATH: "/usr/bin:/bin", GH_TOKEN: "test-manifest-token" });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /refusing to seed from a local snapshot/);
});

test("a publish opens a pull request on a side branch and keeps the other apps", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-pr-"));
  const basePath = join(dir, "base.json");
  const log = join(dir, "calls.jsonl");
  const putPath = join(dir, "put.json");
  writeFileSync(basePath, JSON.stringify(baseDocument()));
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify({ args, token: process.env.GH_TOKEN || "", workflow: process.env.GITHUB_TOKEN || "" }) + "\\n");
const text = args.join(" ");
const base = JSON.parse(readFileSync(process.env.GH_FAKE_BASE, "utf8"));
if (text.includes("contents/") && !args.includes("--method")) {
  if (args.includes("--jq")) { process.stdout.write("blobsha\\n"); process.exit(0); }
  const content = Buffer.from(JSON.stringify(base)).toString("base64");
  process.stdout.write(JSON.stringify({ sha: "blobsha", content }));
  process.exit(0);
}
if (text.includes("/git/ref/heads/ios-versions-publish/")) process.exit(1);
if (text.includes("/git/ref/heads/")) { process.stdout.write("abc123\\n"); process.exit(0); }
if (args.includes("--method") && args.includes("POST") && text.includes("/git/refs")) process.exit(0);
if (args.includes("--method") && args.includes("PUT")) {
  const content = args.find((arg) => arg.startsWith("content=")).slice("content=".length);
  writeFileSync(process.env.GH_FAKE_PUT, Buffer.from(content, "base64"));
  process.stdout.write("{}\\n");
  process.exit(0);
}
if (text.includes("/pulls?") && !args.includes("--method")) { process.stdout.write("null\\n"); process.exit(0); }
if (args.includes("--method") && args.includes("POST") && text.includes("/pulls")) {
  process.stdout.write("https://github.com/Simple-With-Us/AI-Fleet-Coordinator/pull/4242\\n");
  process.exit(0);
}
process.stderr.write("unhandled " + text + "\\n");
process.exit(1);
`);
  chmodSync(join(dir, "gh"), 0o755);
  const result = run([
    "--bundle-id", "com.example.usage",
    "--version", "0.1.0",
    "--build", "202611010101",
    "--apple-id", "6820881005",
    "--display-name", "Usage Monitor",
    "--base-json", basePath,
    "--skip-local-write"
  ], {
    PATH: `${dir}:/usr/bin:/bin`,
    GH_TOKEN: "test-manifest-token",
    GITHUB_TOKEN: "workflow-token",
    GH_FAKE_LOG: log,
    GH_FAKE_BASE: basePath,
    GH_FAKE_PUT: putPath
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /version-manifest-pr https:\/\/github.com\/Simple-With-Us\/AI-Fleet-Coordinator\/pull\/4242/);
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.every((call) => call.token === "test-manifest-token" && call.workflow === ""));
  const put = calls.find((call) => call.args.includes("PUT"));
  assert.ok(put);
  assert.equal(put.args.includes("branch=ios-versions-publish/com.example.usage"), true);
  assert.equal(put.args.some((arg) => arg === "branch=main" || arg.startsWith("branch=refs/heads/main")), false);
  const posted = JSON.parse(readFileSync(putPath, "utf8"));
  assert.equal(posted.apps["trade.socratic.app"].marketingVersion, "1.0.68");
  assert.equal(posted.apps["com.example.usage"].marketingVersion, "0.1.0");
  const pull = calls.find((call) => call.args.includes("POST") && call.args.some((arg) => arg.includes("/pulls")));
  const body = pull.args.find((arg) => arg.startsWith("body=")).slice("body=".length);
  assert.ok(body.includes("\u00a0 "));
  assert.equal(body.includes("&nbsp;"), false);
});
