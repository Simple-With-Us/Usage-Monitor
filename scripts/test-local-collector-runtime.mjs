#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const root = mkdtempSync(join(tmpdir(), "um-collector-runtime-"));
try {
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(join(source, "scripts"), { recursive: true });
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "collector-test@example.invalid"]);
  git(source, ["config", "user.name", "Collector Test"]);
  const scripts = [
    "antigravity-session-collector.mjs",
    "antigravity-statusline-telemetry.mjs",
    "antigravity-usage-collector.mjs",
    "codex-usage-collector.mjs",
    "copilot-usage-collector.mjs",
    "deepseek-usage-collector.mjs",
    "fx-usage-collector.mjs",
    "grok-usage-collector.mjs",
    "minimax-usage-collector.mjs",
    "opencode-usage-collector.mjs",
  ];
  for (const script of scripts) writeFileSync(join(source, "scripts", script), "export {};\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture release one"]);
  const firstSha = git(source, ["rev-parse", "HEAD"]);
  writeFileSync(join(source, "release.txt"), "two\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture release two"]);
  const secondSha = git(source, ["rev-parse", "HEAD"]);

  const updater = join(dirname(fileURLToPath(import.meta.url)), "update-local-collector-runtime.mjs");
  const env = {
    ...process.env,
    USAGE_MONITOR_COLLECTOR_ALLOW_TEST_REPO: "1",
    USAGE_MONITOR_COLLECTOR_REPO_URL: source,
  };
  execFileSync(process.execPath, [updater, "--sha", firstSha, "--runtime-root", runtime], { env });
  assert(readlinkSync(join(runtime, "current")) === `releases/${firstSha}`, "first release activated");
  execFileSync(process.execPath, [updater, "--sha", secondSha, "--runtime-root", runtime], { env });
  assert(readlinkSync(join(runtime, "current")) === `releases/${secondSha}`, "second release activated");
  assert(readlinkSync(join(runtime, "previous")) === `releases/${firstSha}`, "previous release retained");
  execFileSync(process.execPath, [updater, "--rollback", "--runtime-root", runtime], { env });
  assert(readlinkSync(join(runtime, "current")) === `releases/${firstSha}`, "rollback atomically restored prior release");
  assert(readlinkSync(join(runtime, "previous")) === `releases/${secondSha}`, "rollback retained forward release");

  const invalid = spawnSync(
    process.execPath,
    [updater, "--sha", "0".repeat(40), "--runtime-root", join(root, "invalid")],
    { env, encoding: "utf8" },
  );
  assert(invalid.status !== 0, "unknown SHA rejected");
  console.log("ok local-collector-runtime");
} finally {
  rmSync(root, { recursive: true, force: true });
}
