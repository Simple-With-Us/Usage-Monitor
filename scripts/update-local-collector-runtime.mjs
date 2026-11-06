#!/usr/bin/env node
// Installs an exact origin/main commit into a detached local collector runtime.
// LaunchAgents point at <runtime>/current, an atomically replaced symlink.  The
// prior release remains available through <runtime>/previous for rollback.

import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  existsSync,
  cpSync,
  copyFileSync,
  lstatSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

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
  "kimi-usage-collector.mjs",
  "collector-injector.mjs",
  "muse-code-usage-collector.mjs",
  "lib/infisical-service-token.mjs",
  "minimax-usage-collector.mjs",
  "opencode-usage-collector.mjs",
  "zcode-usage-collector.mjs",
];
const NEW_SCRIPTS = new Set(["collector-injector.mjs", "muse-code-usage-collector.mjs", "lib/infisical-service-token.mjs"]);
const SOURCE_ZOD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "zod");
const MAX_RUNTIME_DEPENDENCY_BYTES = 8 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let sha = null;
  let donorSha = null;
  let rollback = false;
  let runtimeRoot = DEFAULT_RUNTIME_ROOT;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--sha" && argv[index + 1]) sha = argv[++index];
    else if (argv[index] === "--migration-donor-sha" && argv[index + 1]) donorSha = argv[++index];
    else if (argv[index] === "--runtime-root" && argv[index + 1]) runtimeRoot = argv[++index];
    else if (argv[index] === "--rollback") rollback = true;
    else fail(`Unknown argument: ${argv[index]}`);
  }
  if (rollback && sha) fail("Use either --rollback or --sha, not both");
  if (!rollback && !/^[a-f0-9]{40}$/.test(sha || "")) fail("--sha requires a full 40-character commit SHA");
  if (donorSha !== null && !/^[a-f0-9]{40}$/.test(donorSha)) fail("--migration-donor-sha requires a full 40-character commit SHA");
  return { rollback, runtimeRoot: resolve(runtimeRoot), sha, donorSha };
}

function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key.startsWith("NODE_") || key.startsWith("DYLD_") || key.startsWith("LD_") || ["OPENSSL_CONF", "OPENSSL_MODULES", "BASH_ENV", "ENV"].includes(key)) delete env[key];
  }
  if (command === "git") Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  return execFileSync(command === "git" ? "/usr/bin/git" : command, command === "git" ? ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args] : args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
    env,
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

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function directory(path) {
  const info = stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(`Invalid runtime directory: ${path}`);
}

function releaseFromLink(runtimeRoot, name, { legacyMigrationSource = false } = {}) {
  const linkPath = join(runtimeRoot, name);
  const info = stat(linkPath);
  if (!info) return null;
  if (!info.isSymbolicLink()) fail(`Invalid runtime ${name} link`);
  const target = resolve(dirname(linkPath), readlinkSync(linkPath));
  const releasesRoot = join(runtimeRoot, "releases");
  const rel = relative(releasesRoot, target);
  return releaseByName(runtimeRoot, rel, { allowLegacy: name === "current" || legacyMigrationSource });
}

function releaseByName(runtimeRoot, rel, { allowLegacy = false } = {}) {
  const identity = typeof rel === "string" && /^(release|compat)-([a-f0-9]{40})-([a-f0-9]{64})$/.exec(rel);
  const legacy = allowLegacy && typeof rel === "string" && /^[a-f0-9]{40}$/.test(rel);
  if (!identity && !legacy) fail("Invalid runtime release target");
  const target = join(runtimeRoot, "releases", rel);
  directory(target);
  if (realpathSync(target) !== target) fail("Invalid runtime release path");
  const sha = run("git", ["-C", target, "rev-parse", "HEAD"], { capture: true }).trim();
  if (sha !== (legacy ? rel : identity[2])) fail("Release identity does not match its Git HEAD");
  validateTrackedScripts(target, sha);
  if (!legacy && releaseDigest(target, sha, identity[1] === "compat") !== identity[3]) fail("Runtime release content identity mismatch");
  return { path: target, name: rel, sha, legacy };
}

function hashRuntimeDependency(path, expected, digest, buffer) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.uid !== process.getuid() || opened.uid !== expected.uid || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.mode !== expected.mode || opened.size !== expected.size) fail("Runtime dependency changed before reading");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > MAX_RUNTIME_DEPENDENCY_BYTES) fail("Runtime dependency exceeds the bounded file size");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(opened.size));
    digest.update(size);
    let offset = 0;
    while (offset < opened.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!count) fail("Runtime dependency changed while reading");
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mode !== opened.mode || after.uid !== opened.uid || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail("Runtime dependency changed while reading");
  } finally { closeSync(fd); }
}

function releaseDigest(releasePath, sha, compatibility = false) {
  const tracked = new Set(run("git", ["-C", releasePath, "ls-tree", "-rz", "--name-only", sha, "--", "scripts"], { capture: true }).split("\0").filter(Boolean));
  const expected = new Set((compatibility ? [...NEW_SCRIPTS] : []).map((name) => `scripts/${name}`).filter((name) => !tracked.has(name)));
  const directories = new Set(["scripts"]);
  for (const name of [...tracked, ...expected]) {
    let parent = dirname(name);
    while (parent !== ".") { directories.add(parent); parent = dirname(parent); }
  }
  const overlays = new Map();
  function walk(name) {
    const path = join(releasePath, name);
    directory(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = `${name}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!directories.has(child)) fail(`Unexpected compatibility directory: ${child}`);
        walk(child);
      } else if (!tracked.has(child)) {
        if (!expected.has(child) || !entry.isFile() || entry.isSymbolicLink()) fail(`Unexpected compatibility overlay: ${child}`);
        overlays.set(child, { bytes: readFileSync(join(releasePath, child)), executable: Boolean(lstatSync(join(releasePath, child)).mode & 0o100) });
      }
    }
  }
  walk("scripts");
  if (overlays.size !== expected.size) fail("Compatibility overlay set is incomplete");
  const modules = join(releasePath, "node_modules");
  directory(modules);
  if (readdirSync(modules).some((name) => name !== "zod")) fail("Unexpected compatibility runtime dependency");
  function dependency(name) {
    const path = join(releasePath, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail("Invalid compatibility runtime dependency");
    overlays.set(name, { path, info, executable: Boolean(info.mode & 0o100), directory: info.isDirectory() });
    if (info.isDirectory()) for (const child of readdirSync(path)) dependency(`${name}/${child}`);
  }
  dependency("node_modules/zod");
  const digest = createHash("sha256");
  const field = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    digest.update(size).update(bytes);
  };
  field("usage-monitor-runtime-release-v1");
  field(compatibility ? "compatibility" : "canonical");
  field(sha);
  field(String(overlays.size));
  const dependencyBuffer = Buffer.alloc(64 * 1024);
  for (const [name, overlay] of [...overlays].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    field(name); field(overlay.directory ? "directory" : "file"); field(overlay.executable ? "100755" : "100644");
    if (overlay.directory) field(Buffer.alloc(0));
    else if (overlay.info) hashRuntimeDependency(overlay.path, overlay.info, digest, dependencyBuffer);
    else field(overlay.bytes);
  }
  return digest.digest("hex");
}

function transitionPath(runtimeRoot) { return join(runtimeRoot, ".transition.json"); }

function readTransition(runtimeRoot) {
  const path = transitionPath(runtimeRoot);
  if (!stat(path)) return null;
  if (!stat(path).isFile() || stat(path).isSymbolicLink()) fail("Invalid runtime transition journal");
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (data?.version !== 1 || !["forward", "rollback", "migration"].includes(data.kind)) fail("Invalid runtime transition journal");
  return {
    kind: data.kind,
    current: releaseByName(runtimeRoot, data.current),
    previous: data.previous === null ? null : releaseByName(runtimeRoot, data.previous),
  };
}

function writeTransition(runtimeRoot, target, previous, kind) {
  const path = transitionPath(runtimeRoot);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, kind, current: target.name, previous: previous?.name ?? null })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function completeTransition(runtimeRoot, transition) {
  validateRelease(transition.current.path, transition.current.sha, { rollback: transition.kind !== "forward" });
  if (transition.kind === "forward") verifyOriginAncestry(runtimeRoot, transition.current.sha);
  if (transition.previous) validateRelease(transition.previous.path, transition.previous.sha, { rollback: true });
  if (transition.kind !== "rollback" && transition.previous) replaceSymlink(join(runtimeRoot, "previous"), join("releases", transition.previous.name));
  replaceSymlink(join(runtimeRoot, "current"), join("releases", transition.current.name));
  if (transition.kind === "rollback" && transition.previous) replaceSymlink(join(runtimeRoot, "previous"), join("releases", transition.previous.name));
  writeReceipt(runtimeRoot);
  rmSync(transitionPath(runtimeRoot));
}

function replaceSymlink(linkPath, target) {
  const temp = `${linkPath}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, linkPath);
}

function writeReceipt(runtimeRoot) {
  const current = releaseFromLink(runtimeRoot, "current");
  const previous = releaseFromLink(runtimeRoot, "previous");
  const path = join(runtimeRoot, "runtime-state.json");
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({
    version: 1,
    currentSha: current?.sha ?? null,
    previousSha: previous?.sha ?? null,
    currentRelease: current?.name ?? null,
    previousRelease: previous?.name ?? null,
    currentLegacyUnbound: current?.legacy ?? false,
    updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function installRuntimeDependency(releasePath) {
  const modules = join(releasePath, "node_modules");
  const target = join(modules, "zod");
  if (stat(modules)) directory(modules);
  else mkdirSync(modules);
  if (!stat(target)) {
    if (!existsSync(join(SOURCE_ZOD, "package.json"))) fail("Invoking checkout has no installed zod dependency");
    const temp = mkdtempSync(join(modules, ".zod-stage-"));
    try {
      cpSync(SOURCE_ZOD, join(temp, "zod"), { recursive: true, dereference: true, errorOnExist: true });
      renameSync(join(temp, "zod"), target);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) fail("Invalid runtime zod dependency");
  run(process.execPath, ["--input-type=module", "-e", "await import('./node_modules/zod/index.js')"], { cwd: releasePath, capture: true });
}

function validateTrackedScripts(releasePath, sha) {
  if (run("git", ["-C", releasePath, "rev-parse", "--show-toplevel"], { capture: true }).trim() !== realpathSync(releasePath)) fail("Release is not a standalone repository");
  const actual = run("git", ["-C", releasePath, "rev-parse", "HEAD"], { capture: true }).trim();
  if (actual !== sha) fail("Release HEAD does not match the requested SHA");
  try { run("git", ["-C", releasePath, "fsck", "--strict", "--full", "--no-reflogs", "--no-dangling", sha], { capture: true }); }
  catch { fail("Release Git object integrity check failed"); }
  const entries = run("git", ["-C", releasePath, "ls-tree", "-rz", sha, "--", "scripts", "package.json"], { capture: true }).split("\0").filter(Boolean);
  let rootManifest = false;
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(scripts\/[^\0]+|package\.json)$/.exec(entry);
    if (!match || match[3].split("/").some((part) => part === "." || part === "..")) fail("Invalid tracked script entry");
    const [, mode, object, name] = match;
    if (name === "package.json") rootManifest = true;
    const path = join(releasePath, name);
    const info = stat(path);
    if (!info?.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) fail("Invalid tracked script file");
    const bytes = readFileSync(path);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== object) fail(`Release has modified tracked scripts: ${name} (content mismatch)`);
    // Git records the owner's executable flag; checkout applies the current
    // umask to group/other permissions without changing the tracked mode.
    if (Boolean(info.mode & 0o100) !== (mode === "100755")) fail(`Release has modified tracked scripts: ${name} (executable mode mismatch)`);
  }
  if (!rootManifest) fail("Release must include a tracked root package manifest");
}

function validateRelease(releasePath, sha, { rollback = false, legacy = false, installDependencies = false } = {}) {
  directory(releasePath);
  const name = relative(dirname(releasePath), releasePath);
  const bound = /^(?:release|compat)-/.test(name);
  if (bound && releaseByName(dirname(dirname(releasePath)), name).sha !== sha) fail("Release HEAD does not match the requested SHA");
  directory(join(releasePath, "scripts"));
  directory(join(releasePath, "scripts", "lib"));
  // Bound resolution just checked tracked source and dependencies at this same use boundary.
  if (!bound) validateTrackedScripts(releasePath, sha);
  for (const script of REQUIRED_SCRIPTS) {
    if (legacy && NEW_SCRIPTS.has(script)) continue;
    const path = join(releasePath, "scripts", script);
    if (!rollback) {
      try { run("git", ["-C", releasePath, "cat-file", "-e", `${sha}:scripts/${script}`], { capture: true }); }
      catch { fail(`Release commit is missing scripts/${script}`); }
    }
    if (!stat(path)?.isFile() || stat(path).isSymbolicLink()) fail(`Release is missing regular scripts/${script}`);
    run(process.execPath, ["--check", path], { capture: true });
  }
  if (installDependencies) installRuntimeDependency(releasePath);
  directory(join(releasePath, "node_modules"));
  directory(join(releasePath, "node_modules", "zod"));
  run(process.execPath, ["--input-type=module", "-e", "await import('./node_modules/zod/index.js')"], { cwd: releasePath, capture: true });
  if (!legacy) {
    run(process.execPath, ["--input-type=module", "-e", "await import('./scripts/kimi-usage-collector.mjs'); await import('./scripts/zcode-usage-collector.mjs'); await import('./scripts/muse-code-usage-collector.mjs'); await import('./scripts/collector-injector.mjs'); await import('./scripts/lib/collector-sentry-bridge.mjs')"], { cwd: releasePath, capture: true });
  }
}

function preparePreviousRelease(previousPath, previousSha, newPath) {
  const scripts = join(previousPath, "scripts");
  if (!lstatSync(scripts).isDirectory() || lstatSync(scripts).isSymbolicLink()) fail("Invalid compatibility overlay directory");
  const temp = mkdtempSync(join(dirname(previousPath), ".compat-stage-"));
  try {
    if (/^[a-f0-9]{40}$/.test(relative(dirname(previousPath), previousPath))) {
      // Rebuild tracked source; never traverse or copy an unbound dependency tree.
      validateTrackedScripts(previousPath, previousSha);
      checkoutApprovedSource(temp, previousSha);
    } else {
      cpSync(previousPath, temp, { recursive: true, verbatimSymlinks: true });
    }
    validateRelease(temp, previousSha, { rollback: true, legacy: true, installDependencies: true });
    for (const script of NEW_SCRIPTS) {
      const target = join(temp, "scripts", script);
      const parent = dirname(target);
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) fail("Invalid compatibility overlay directory");
      let targetStat = null;
      try { targetStat = lstatSync(target); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) fail("Invalid compatibility overlay entry");
      const tracked = run("git", ["-C", temp, "ls-tree", "-z", previousSha, "--", `scripts/${script}`], { capture: true });
      if (tracked.length > 0) continue;
      copyFileSync(join(newPath, "scripts", script), join(temp, "scripts", script));
    }
    const name = `compat-${previousSha}-${releaseDigest(temp, previousSha, true)}`;
    validateRelease(temp, previousSha, { rollback: true });
    if (stat(join(dirname(previousPath), name))) {
      const existing = releaseByName(dirname(dirname(previousPath)), name);
      validateRelease(existing.path, previousSha, { rollback: true });
    } else renameSync(temp, join(dirname(previousPath), name));
    return { path: join(dirname(previousPath), name), name, sha: previousSha };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function checkoutApprovedSource(path, sha = null) {
  run("git", ["-C", path, "init", "--quiet", "--template="]);
  run("git", ["-C", path, "remote", "add", "origin", repositoryUrl()]);
  run("git", ["-C", path, "fetch", "--quiet", "--filter=blob:none", "origin", "main"]);
  if (sha === null) sha = run("git", ["-C", path, "rev-parse", "FETCH_HEAD"], { capture: true }).trim();
  try {
    run("git", ["-C", path, "cat-file", "-e", `${sha}^{commit}`], { capture: true });
    run("git", ["-C", path, "merge-base", "--is-ancestor", sha, "FETCH_HEAD"], { capture: true });
  } catch {
    fail("Requested SHA is not an ancestor of current origin/main");
  }
  run("git", ["-C", path, "checkout", "--quiet", "--detach", sha]);
  return sha;
}

function stageRelease(runtimeRoot, sha = null) {
  const releasesRoot = join(runtimeRoot, "releases");
  const stage = sha === null ? mkdtempSync(join(releasesRoot, ".migration-stage-")) : join(releasesRoot, `.staging-${sha}-${process.pid}`);
  if (sha !== null) {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
  }
  try {
    sha = checkoutApprovedSource(stage, sha);
    validateRelease(stage, sha, { installDependencies: true });
    const name = `release-${sha}-${releaseDigest(stage, sha)}`;
    const releasePath = join(releasesRoot, name);
    if (stat(releasePath)) {
      const existing = releaseByName(runtimeRoot, name);
      validateRelease(existing.path, sha);
    } else renameSync(stage, releasePath);
    return releaseByName(runtimeRoot, name);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function verifyOriginAncestry(runtimeRoot, sha) {
  const temp = mkdtempSync(join(runtimeRoot, "releases", ".ancestry-stage-"));
  try {
    run("git", ["-C", temp, "init", "--quiet", "--template="]);
    run("git", ["-C", temp, "remote", "add", "origin", repositoryUrl()]);
    run("git", ["-C", temp, "fetch", "--quiet", "--filter=blob:none", "origin", "main"]);
    try { run("git", ["-C", temp, "merge-base", "--is-ancestor", sha, "FETCH_HEAD"], { capture: true }); }
    catch { fail("Requested SHA is not an ancestor of current origin/main"); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function pruneReleases(runtimeRoot) {
  const releasesRoot = join(runtimeRoot, "releases");
  const referenced = new Set([releaseFromLink(runtimeRoot, "current")?.name, releaseFromLink(runtimeRoot, "previous")?.name]);
  const pending = readTransition(runtimeRoot);
  if (pending) { referenced.add(pending.current.name); referenced.add(pending.previous?.name); }
  const candidates = readdirSync(releasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(?:\.(?:compat|ancestry|migration)-stage-[A-Za-z0-9]+|\.staging-[a-f0-9]{40}-[0-9]+)$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((sha) => !referenced.has(sha))
    .sort((a, b) => lstatSync(join(releasesRoot, b)).mtimeMs - lstatSync(join(releasesRoot, a)).mtimeMs);
  for (const sha of candidates) {
    rmSync(join(releasesRoot, sha), { recursive: true, force: true });
  }
}

function activate(runtimeRoot, target, { rollback = false } = {}) {
  const current = releaseFromLink(runtimeRoot, "current");
  validateRelease(target.path, target.sha, { rollback });
  if (current && current.name !== target.name) {
    const previous = rollback ? current : preparePreviousRelease(current.path, current.sha, target.path);
    writeTransition(runtimeRoot, target, previous, rollback ? "rollback" : "forward");
  } else {
    writeTransition(runtimeRoot, target, releaseFromLink(runtimeRoot, "previous"), rollback ? "rollback" : "forward");
  }
  completeTransition(runtimeRoot, readTransition(runtimeRoot));
  pruneReleases(runtimeRoot);
  return { currentSha: target.sha, previousSha: releaseFromLink(runtimeRoot, "previous")?.sha ?? null };
}

function migrateLegacyLinks(runtimeRoot, args) {
  const hasLegacyLink = ["current", "previous"].some((name) => {
    const link = join(runtimeRoot, name);
    if (!stat(link)?.isSymbolicLink()) return false;
    return /^[a-f0-9]{40}$/.test(relative(join(runtimeRoot, "releases"), resolve(dirname(link), readlinkSync(link))));
  });
  // No migration consumes these releases; the following receipt still validates both links.
  if (!hasLegacyLink) return;
  const current = releaseFromLink(runtimeRoot, "current");
  const previous = releaseFromLink(runtimeRoot, "previous", { legacyMigrationSource: true });
  if (!current?.legacy && !previous?.legacy) return;
  if (!current) fail("Cannot migrate legacy previous without an active current release");
  const candidates = args.donorSha ? [{ sha: args.donorSha }] : [
    ...[current, previous].filter((release) => release && !release.legacy).map((release) => ({ release })),
    ...(args.rollback ? [...new Set([current.sha, previous?.sha].filter(Boolean))].map((sha) => ({ sha })) : []),
    { sha: args.rollback ? null : args.sha },
  ];
  let selected;
  let lastError;
  for (const candidate of candidates) {
    try {
      const donor = candidate.release ?? stageRelease(runtimeRoot, candidate.sha);
      if (candidate.release) verifyOriginAncestry(runtimeRoot, donor.sha);
      validateRelease(donor.path, donor.sha, { rollback: true });
      const migratedCurrent = current.legacy ? preparePreviousRelease(current.path, current.sha, donor.path) : current;
      const migratedPrevious = previous?.legacy ? preparePreviousRelease(previous.path, previous.sha, donor.path) : previous;
      selected = { migratedCurrent, migratedPrevious };
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!selected) fail(`No compatible approved migration donor is available; use --migration-donor-sha to pin one after verification; reason: ${lastError?.message || "No donor candidates"}`);
  // Migration changes identities only; the requested forward/rollback action runs afterward.
  writeTransition(runtimeRoot, selected.migratedCurrent, selected.migratedPrevious, "migration");
  completeTransition(runtimeRoot, readTransition(runtimeRoot));
}

function processIdentity(pid) {
  try {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return null;
      if (error.code !== "EPERM") throw error;
    }
    let identity;
    if (process.platform === "linux") {
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = fields.slice(fields.lastIndexOf(")") + 2).split(" ")[19];
      if (!/^\d+$/.test(start)) fail("Cannot verify updater process start identity");
      identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else if (process.platform === "darwin") {
      identity = run("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { capture: true }).trim();
      if (!identity) return null;
    } else fail("Cannot verify updater process start identity on this platform");
    return createHash("sha256").update(identity).digest("hex");
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return null;
    throw error;
  }
}

function acquireLock(runtimeRoot) {
  const lock = join(runtimeRoot, ".update.lock");
  if (stat(lock)) directory(lock);
  else mkdirSync(lock, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  // Darwin ps exposes start time at second resolution.  Bind its verified
  // command title to this nonce too so same-second PID reuse cannot match.
  if (process.platform === "darwin") {
    // argv capacity can truncate the title; put the complete nonce before the label.
    process.title = `${nonce} um-collector-updater`;
    if (!run("ps", ["-p", String(process.pid), "-o", "command="], { capture: true }).includes(nonce)) fail("Cannot verify updater process nonce");
  }
  const ownName = `${process.pid}-${processIdentity(process.pid)}-${nonce}`;
  const ownPath = join(lock, ownName);
  mkdirSync(ownPath, { mode: 0o700 });
  try {
    // Every contender publishes its own unique entry before inspecting peers.
    // Two simultaneous contenders may both decline; they cannot both proceed.
    for (const entry of readdirSync(lock)) {
      if (entry === ownName) continue;
      const match = /^([1-9][0-9]*)-([a-f0-9]{64})-[a-f0-9-]{36}$/.exec(entry);
      if (!match) fail("Invalid collector update lock entry");
      directory(join(lock, entry));
      if (processIdentity(Number(match[1])) === match[2]) fail("Another collector runtime update is active");
      rmSync(join(lock, entry), { recursive: true, force: true });
    }
    return () => rmSync(ownPath, { recursive: true, force: true });
  } catch (error) {
    rmSync(ownPath, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major !== 24) fail("Collector runtime updates require Node 24.x");
  const args = parseArgs(process.argv);
  let ancestor = args.runtimeRoot;
  while (!stat(ancestor)) ancestor = dirname(ancestor);
  directory(ancestor);
  if (realpathSync(ancestor) !== ancestor) fail("Runtime root must not traverse symlinks");
  mkdirSync(args.runtimeRoot, { recursive: true, mode: 0o700 });
  directory(args.runtimeRoot);
  if (!stat(join(args.runtimeRoot, "releases"))) mkdirSync(join(args.runtimeRoot, "releases"));
  directory(join(args.runtimeRoot, "releases"));
  if (realpathSync(args.runtimeRoot) !== args.runtimeRoot) fail("Runtime root must not traverse symlinks");
  const releaseLock = acquireLock(args.runtimeRoot);
  try {
    const pending = readTransition(args.runtimeRoot);
    if (pending) completeTransition(args.runtimeRoot, pending);
    migrateLegacyLinks(args.runtimeRoot, args);
    writeReceipt(args.runtimeRoot);
    const target = args.rollback ? releaseFromLink(args.runtimeRoot, "previous") : stageRelease(args.runtimeRoot, args.sha);
    if (!target) fail("No previous collector runtime is available for rollback");
    const state = activate(args.runtimeRoot, target, { rollback: args.rollback });
    console.log(JSON.stringify({ ok: true, ...state, runtimeRoot: args.runtimeRoot }));
  } finally {
    releaseLock();
  }
}

try {
  main();
} catch (error) {
  console.error(`[collector-runtime] ${error instanceof Error ? error.message : "update failed"}`);
  process.exit(1);
}
