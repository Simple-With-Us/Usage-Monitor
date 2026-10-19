#!/usr/bin/env node
// Installs an exact origin/main commit into a detached local collector runtime.
// LaunchAgents point at <runtime>/current, an atomically replaced symlink.  The
// prior release remains available through <runtime>/previous for rollback.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const DEFAULT_RUNTIME_ROOT = join(process.env.HOME || "", "apps", "usage-monitor-collector-runtime");
const PRODUCTION_REPO_URL = "https://github.com/Simple-With-Us/Usage-Monitor.git";
const REQUIRED_SCRIPTS = [
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

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let sha = null;
  let rollback = false;
  let runtimeRoot = DEFAULT_RUNTIME_ROOT;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--sha" && argv[index + 1]) sha = argv[++index];
    else if (argv[index] === "--runtime-root" && argv[index + 1]) runtimeRoot = argv[++index];
    else if (argv[index] === "--rollback") rollback = true;
    else fail(`Unknown argument: ${argv[index]}`);
  }
  if (rollback && sha) fail("Use either --rollback or --sha, not both");
  if (!rollback && !/^[a-f0-9]{40}$/.test(sha || "")) fail("--sha requires a full 40-character commit SHA");
  return { rollback, runtimeRoot: resolve(runtimeRoot), sha };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
}

function repositoryUrl() {
  if (
    process.env.USAGE_MONITOR_COLLECTOR_ALLOW_TEST_REPO === "1" &&
    process.env.USAGE_MONITOR_COLLECTOR_REPO_URL
  ) {
    return process.env.USAGE_MONITOR_COLLECTOR_REPO_URL;
  }
  return PRODUCTION_REPO_URL;
}

function releaseShaFromLink(runtimeRoot, name) {
  const linkPath = join(runtimeRoot, name);
  if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) return null;
  const target = resolve(dirname(linkPath), readlinkSync(linkPath));
  const releasesRoot = join(runtimeRoot, "releases");
  const rel = relative(releasesRoot, target);
  if (!/^[a-f0-9]{40}$/.test(rel) || !existsSync(target)) return null;
  return rel;
}

function replaceSymlink(linkPath, target) {
  const temp = `${linkPath}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, linkPath);
}

function writeReceipt(runtimeRoot, currentSha, previousSha) {
  const path = join(runtimeRoot, "runtime-state.json");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({
    version: 1,
    currentSha,
    previousSha,
    updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function validateRelease(releasePath, sha) {
  const actual = run("git", ["-C", releasePath, "rev-parse", "HEAD"], { capture: true }).trim();
  if (actual !== sha) fail("Release HEAD does not match the requested SHA");
  for (const script of REQUIRED_SCRIPTS) {
    const path = join(releasePath, "scripts", script);
    if (!existsSync(path)) fail(`Release is missing scripts/${script}`);
    run(process.execPath, ["--check", path], { capture: true });
  }
}

function stageRelease(runtimeRoot, sha) {
  const releasesRoot = join(runtimeRoot, "releases");
  const releasePath = join(releasesRoot, sha);
  if (existsSync(releasePath)) {
    validateRelease(releasePath, sha);
    return releasePath;
  }
  const stage = join(releasesRoot, `.staging-${sha}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    run("git", ["-C", stage, "init", "--quiet"]);
    run("git", ["-C", stage, "remote", "add", "origin", repositoryUrl()]);
    run("git", ["-C", stage, "fetch", "--quiet", "--filter=blob:none", "origin", "main"]);
    run("git", ["-C", stage, "cat-file", "-e", `${sha}^{commit}`], { capture: true });
    try {
      run("git", ["-C", stage, "merge-base", "--is-ancestor", sha, "FETCH_HEAD"], { capture: true });
    } catch {
      fail("Requested SHA is not an ancestor of current origin/main");
    }
    run("git", ["-C", stage, "checkout", "--quiet", "--detach", sha]);
    validateRelease(stage, sha);
    renameSync(stage, releasePath);
    return releasePath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function pruneReleases(runtimeRoot, keepShas) {
  const releasesRoot = join(runtimeRoot, "releases");
  const candidates = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((sha) => !keepShas.has(sha))
    .sort((a, b) => lstatSync(join(releasesRoot, b)).mtimeMs - lstatSync(join(releasesRoot, a)).mtimeMs);
  for (const sha of candidates.slice(1)) {
    rmSync(join(releasesRoot, sha), { recursive: true, force: true });
  }
}

function activate(runtimeRoot, sha) {
  const currentSha = releaseShaFromLink(runtimeRoot, "current");
  const releasePath = join(runtimeRoot, "releases", sha);
  validateRelease(releasePath, sha);
  if (currentSha && currentSha !== sha) {
    replaceSymlink(join(runtimeRoot, "previous"), join("releases", currentSha));
  }
  replaceSymlink(join(runtimeRoot, "current"), join("releases", sha));
  const previousSha = releaseShaFromLink(runtimeRoot, "previous");
  writeReceipt(runtimeRoot, sha, previousSha);
  pruneReleases(runtimeRoot, new Set([sha, previousSha].filter(Boolean)));
  return { currentSha: sha, previousSha };
}

function main() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major !== 24) fail("Collector runtime updates require Node 24.x");
  const args = parseArgs(process.argv);
  mkdirSync(join(args.runtimeRoot, "releases"), { recursive: true });
  const lock = join(args.runtimeRoot, ".update.lock");
  try {
    mkdirSync(lock);
  } catch {
    fail("Another collector runtime update is active");
  }
  try {
    const targetSha = args.rollback
      ? releaseShaFromLink(args.runtimeRoot, "previous")
      : args.sha;
    if (!targetSha) fail("No previous collector runtime is available for rollback");
    if (!args.rollback) stageRelease(args.runtimeRoot, targetSha);
    const state = activate(args.runtimeRoot, targetSha);
    console.log(JSON.stringify({ ok: true, ...state, runtimeRoot: args.runtimeRoot }));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`[collector-runtime] ${error instanceof Error ? error.message : "update failed"}`);
  process.exit(1);
}
