#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "um-collector-runtime-")));
try {
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  mkdirSync(source, { recursive: true });
  cpSync(join(repoRoot, "scripts"), join(source, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(source, "package.json"));
  const newScripts = ["collector-injector.mjs", "muse-code-usage-collector.mjs", "lib/infisical-service-token.mjs"];
  for (const script of newScripts.filter((entry) => entry !== "lib/infisical-service-token.mjs")) rmSync(join(source, "scripts", script));
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.email", "collector-test@example.invalid"]);
  git(source, ["config", "user.name", "Collector Test"]);
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture release one"]);
  const firstSha = git(source, ["rev-parse", "HEAD"]);
  const firstTrackedCompatibility = readFileSync(join(source, "scripts", "lib", "infisical-service-token.mjs"));
  for (const script of newScripts) cpSync(join(repoRoot, "scripts", script), join(source, "scripts", script));
  writeFileSync(join(source, "scripts", "lib", "infisical-service-token.mjs"), `${firstTrackedCompatibility.toString()}\n// fixture release two tracked change\n`);
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture release two"]);
  const secondSha = git(source, ["rev-parse", "HEAD"]);
  const secondInjector = readFileSync(join(source, "scripts", "collector-injector.mjs"));

  const updater = join(dirname(fileURLToPath(import.meta.url)), "update-local-collector-runtime.mjs");
  const env = {
    ...process.env,
    USAGE_MONITOR_COLLECTOR_ALLOW_TEST_REPO: "1",
    USAGE_MONITOR_COLLECTOR_REPO_URL: source,
  };
  const oldForward = spawnSync(process.execPath, [updater, "--sha", firstSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(oldForward.status !== 0 && !existsSync(join(runtime, "current")), "old release cannot be newly activated");
  const isolated = join(root, "isolated", "scripts");
  mkdirSync(isolated, { recursive: true });
  cpSync(updater, join(isolated, "updater.mjs"));
  const missingZod = spawnSync(process.execPath, [join(isolated, "updater.mjs"), "--sha", secondSha, "--runtime-root", join(root, "no-dependency")], { env, encoding: "utf8" });
  assert(missingZod.status !== 0 && !existsSync(join(root, "no-dependency", "current")), "missing invoking dependency blocks activation");
  mkdirSync(join(runtime, "releases"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", source, join(runtime, "releases", firstSha)]);
  git(join(runtime, "releases", firstSha), ["checkout", "--quiet", "--detach", firstSha]);
  const legacyMarker = join(root, "legacy-dependency-executed");
  const legacyDependency = join(runtime, "releases", firstSha, "node_modules", "zod");
  mkdirSync(legacyDependency, { recursive: true });
  writeFileSync(join(legacyDependency, "package.json"), '{"type":"module"}\n');
  const legacyBytes = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(legacyMarker)}, 'unsafe'); throw new Error('unbound legacy dependency must not execute');\n`;
  writeFileSync(join(legacyDependency, "index.js"), legacyBytes);
  symlinkSync(`releases/${firstSha}`, join(runtime, "current"));
  const originalUmask = process.umask(0o077);
  try { execFileSync(process.execPath, [updater, "--sha", secondSha, "--runtime-root", runtime], { env }); }
  finally { process.umask(originalUmask); }
  assert((lstatSync(join(runtime, "current", "scripts", "antigravity-session-collector.mjs")).mode & 0o777) === 0o700, "Git executable mode validates under a restrictive checkout umask");
  const secondRelease = readlinkSync(join(runtime, "current"));
  assert(secondRelease.startsWith(`releases/release-${secondSha}-`), "second release activated with bound runtime dependencies");
  assert(!existsSync(legacyMarker) && readFileSync(join(legacyDependency, "index.js"), "utf8") === legacyBytes, "migration neither executes nor modifies the unbound legacy dependency");
  const firstCompatibility = readlinkSync(join(runtime, "previous"));
  assert(firstCompatibility.startsWith(`releases/compat-${firstSha}-`), "previous release retained as a separate compatibility tree");
  assert(existsSync(join(runtime, "releases", firstSha)), "published canonical legacy tree remains available to already-running collectors");
  assert(git(join(runtime, "previous"), ["rev-parse", "HEAD"]) === firstSha, "overlay preserves prior commit");
  assert(readFileSync(join(runtime, "previous", "scripts", "lib", "infisical-service-token.mjs")).equals(firstTrackedCompatibility), "tracked compatibility file is never overwritten");
  git(join(runtime, "previous"), ["diff", "--exit-code"]);
  const overlaidForward = spawnSync(process.execPath, [updater, "--sha", firstSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(overlaidForward.status !== 0 && readlinkSync(join(runtime, "current")) === secondRelease, "overlay cannot authorize a new activation of an old commit");
  assert(existsSync(join(runtime, "current", "node_modules", "zod", "package.json")), "release contains its own zod copy");
  execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/kimi-usage-collector.mjs'); await import('./scripts/zcode-usage-collector.mjs'); await import('./scripts/lib/collector-sentry-bridge.mjs')"], { cwd: join(runtime, "current") });
  execFileSync(process.execPath, [updater, "--rollback", "--runtime-root", runtime], { env });
  assert(readlinkSync(join(runtime, "current")) === firstCompatibility, "rollback atomically restored prior compatibility release");
  assert(readlinkSync(join(runtime, "previous")) === secondRelease, "rollback retained forward release");
  execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/collector-injector.mjs'); await import('./scripts/muse-code-usage-collector.mjs')"], { cwd: join(runtime, "current") });
  const priorOverlay = new Map(newScripts.map((script) => [script, readFileSync(join(runtime, "current", "scripts", script))]));
  writeFileSync(join(source, "scripts", "lib", "collector-overlay-only.mjs"), "export {};\n");
  writeFileSync(join(source, "scripts", "collector-injector.mjs"), `${secondInjector.toString()}\nimport './lib/collector-overlay-only.mjs';\n`);
  writeFileSync(join(source, "scripts", "muse-code-usage-collector.mjs"), `${priorOverlay.get("muse-code-usage-collector.mjs").toString()}\n// incompatible overlay fixture\n`);
  git(source, ["add", "scripts"]);
  git(source, ["commit", "-m", "fixture incompatible compatibility dependency"]);
  const incompatibleSha = git(source, ["rev-parse", "HEAD"]);
  const incompatible = spawnSync(process.execPath, [updater, "--sha", incompatibleSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(incompatible.status !== 0, "candidate requiring a dependency missing from the previous release is rejected");
  const incompatibleRelease = readdirSync(join(runtime, "releases")).find((name) => name.startsWith(`release-${incompatibleSha}-`));
  assert(incompatibleRelease && existsSync(join(runtime, "releases", incompatibleRelease, "scripts", "lib", "collector-overlay-only.mjs")), "incompatible candidate passed its own staging validation");
  assert(readlinkSync(join(runtime, "current")) === firstCompatibility, "failed overlay validation preserves current release");
  assert(readlinkSync(join(runtime, "previous")) === secondRelease, "failed overlay validation preserves previous release");
  for (const [script, bytes] of priorOverlay) assert(readFileSync(join(runtime, "current", "scripts", script)).equals(bytes), `failed validation preserves every byte of ${script}`);
  git(join(runtime, "current"), ["diff", "--exit-code"]);
  execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/collector-injector.mjs'); await import('./scripts/muse-code-usage-collector.mjs')"], { cwd: join(runtime, "current") });
  cpSync(join(repoRoot, "scripts", "muse-code-usage-collector.mjs"), join(source, "scripts", "muse-code-usage-collector.mjs"));
  writeFileSync(join(source, "scripts", "collector-injector.mjs"), `${secondInjector.toString()}\n// fixture release three overlay update\n`);
  git(source, ["add", "scripts"]);
  git(source, ["commit", "-m", "fixture release three"]);
  const thirdSha = git(source, ["rev-parse", "HEAD"]);
  const runnable = (home, link) => {
    git(join(home, link), ["diff", "--exit-code"]);
    execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./scripts/kimi-usage-collector.mjs'); await import('./scripts/zcode-usage-collector.mjs'); await import('./scripts/collector-injector.mjs'); await import('./scripts/muse-code-usage-collector.mjs')"], { cwd: join(home, link) });
  };
  const truthfulReceipt = (home) => {
    const receipt = JSON.parse(readFileSync(join(home, "runtime-state.json"), "utf8"));
    for (const link of ["current", "previous"]) {
      assert(receipt[`${link}Sha`] === git(join(home, link), ["rev-parse", "HEAD"]), `${link} receipt SHA matches the actual commit`);
      assert(`releases/${receipt[`${link}Release`]}` === readlinkSync(join(home, link)), `${link} receipt identifies the actual tree`);
    }
  };
  const boundaries = ["dependency", "release", "compatibility", "journal", "previous", "current", "receipt", "journal-removal"];
  for (const boundary of boundaries) {
    const crashRuntime = join(root, `crash-${boundary}`);
    cpSync(runtime, crashRuntime, { recursive: true, verbatimSymlinks: true });
    const crashHook = join(root, `crash-${boundary}.mjs`);
    writeFileSync(crashHook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.renameSync;
fs.renameSync = (source, target) => {
  const result = original(source, target);
  const boundary = ${JSON.stringify(boundary)};
  const home = ${JSON.stringify(crashRuntime)};
  if ((boundary === 'dependency' && target.endsWith('/node_modules/zod')) ||
      (boundary === 'release' && target.startsWith(home + '/releases/release-${thirdSha}-')) ||
      (boundary === 'compatibility' && target.startsWith(home + '/releases/compat-')) ||
      (boundary === 'journal' && target === home + '/.transition.json') ||
      (boundary === 'previous' && target === home + '/previous') ||
      (boundary === 'current' && target === home + '/current') ||
      (boundary === 'receipt' && target === home + '/runtime-state.json' && fs.readlinkSync(home + '/current').startsWith('releases/release-${thirdSha}-'))) process.exit(86);
  return result;
};
const originalRemove = fs.rmSync;
fs.rmSync = (path, options) => {
  const result = originalRemove(path, options);
  if (${JSON.stringify(boundary)} === 'journal-removal' && path === ${JSON.stringify(join(crashRuntime, ".transition.json"))}) process.exit(86);
  return result;
}; syncBuiltinESMExports();\n`);
    const crashed = spawnSync(process.execPath, ["--import", crashHook, updater, "--sha", thirdSha, "--runtime-root", crashRuntime], { env, encoding: "utf8" });
    assert(crashed.status === 86, `process exits at the ${boundary} publication boundary`);
    runnable(crashRuntime, "current");
    runnable(crashRuntime, "previous");
    for (const [script, bytes] of priorOverlay) assert(readFileSync(join(crashRuntime, firstCompatibility, "scripts", script)).equals(bytes), `crash never mutates active tree bytes for ${script}`);
    execFileSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", crashRuntime], { env });
    runnable(crashRuntime, "current");
    runnable(crashRuntime, "previous");
    truthfulReceipt(crashRuntime);
    assert(readdirSync(join(crashRuntime, ".update.lock")).length === 0, "recovery clears process-death locks");
    assert(!readdirSync(join(crashRuntime, "releases")).some((name) => name.startsWith(".")), "recovery prunes abandoned staged trees");
  }
  const lockIdentity = process.platform === "linux"
    ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").slice(-1)[0].split(" ")[19]}`
    : execFileSync("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim();
  const liveLock = join(runtime, ".update.lock", `${process.pid}-${createHash("sha256").update(lockIdentity).digest("hex")}-00000000-0000-0000-0000-000000000000`);
  mkdirSync(liveLock);
  const concurrent = spawnSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(concurrent.status !== 0 && concurrent.stderr.includes("Another collector runtime update is active"), "a live updater excludes concurrent mutation");
  rmSync(liveLock, { recursive: true });
  assert(readlinkSync(join(runtime, "current")) === firstCompatibility, "failed concurrent update preserves current");
  const reusedPidLock = join(runtime, ".update.lock", `${process.pid}-${"0".repeat(64)}-00000000-0000-0000-0000-000000000000`);
  mkdirSync(reusedPidLock);
  const publicationFailureHook = join(root, "publication-failure.mjs");
  writeFileSync(publicationFailureHook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target.startsWith(${JSON.stringify(join(runtime, "releases", "compat-"))})) throw new Error('fixture publication failure');
  return original(source, target);
}; syncBuiltinESMExports();\n`);
  const publicationFailure = spawnSync(process.execPath, ["--import", publicationFailureHook, updater, "--sha", thirdSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(publicationFailure.status !== 0 && publicationFailure.stderr.includes("fixture publication failure"), "compatibility publication failure is reported");
  assert(!existsSync(reusedPidLock), "a live unrelated process with a reused PID does not retain a stale lock");
  assert(readlinkSync(join(runtime, "current")) === firstCompatibility && readlinkSync(join(runtime, "previous")) === secondRelease, "publication failure preserves both active links");
  for (const [script, bytes] of priorOverlay) assert(readFileSync(join(runtime, "current", "scripts", script)).equals(bytes), `publication failure preserves every byte of ${script}`);
  execFileSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", runtime], { env });
  const thirdRelease = readlinkSync(join(runtime, "current"));
  assert(thirdRelease.startsWith(`releases/release-${thirdSha}-`), "third release activated after rollback with bound runtime dependencies");
  assert(readlinkSync(join(runtime, "previous")).startsWith(`releases/compat-${firstSha}-`), "rolled-back release retained as a refreshed compatibility tree");
  assert(readlinkSync(join(runtime, "previous")) !== firstCompatibility, "compatibility refresh publishes a distinct tree");
  assert(existsSync(join(runtime, firstCompatibility, "scripts", "collector-injector.mjs")), "the original published compatibility launcher and its collector paths survive refresh");
  runnable(runtime, firstCompatibility);
  assert(existsSync(join(runtime, secondRelease, "scripts", "muse-code-usage-collector.mjs")), "unreferenced published canonical collectors remain available to existing processes");
  const refreshedOverlay = readFileSync(join(runtime, "previous", "scripts", "collector-injector.mjs"));
  assert(refreshedOverlay.equals(readFileSync(join(source, "scripts", "collector-injector.mjs"))), "untracked compatibility overlay refreshed from validated release");
  assert(!refreshedOverlay.equals(secondInjector), "changed overlay file is refreshed after rollback");
  assert(readFileSync(join(runtime, "previous", "scripts", "lib", "infisical-service-token.mjs")).equals(firstTrackedCompatibility), "tracked compatibility file stays unchanged after overlay refresh");
  truthfulReceipt(runtime);
  const dependencyTampers = ["dependency-content", "dependency-addition", "dependency-removal", "dependency-mode", "dependency-directory", "dependency-symlink"];
  function alterDependency(home, target, tamper) {
    const directory = join(home, target, "node_modules", "zod");
    const entry = join(directory, "index.js");
    if (tamper === "dependency-content") writeFileSync(entry, `${readFileSync(entry, "utf8")}// changed dependency\n`);
    if (tamper === "dependency-addition") writeFileSync(join(directory, "added.mjs"), "export {};\n");
    if (tamper === "dependency-removal") rmSync(entry);
    if (tamper === "dependency-mode") chmodSync(entry, (lstatSync(entry).mode & 0o777) ^ 0o100);
    if (tamper === "dependency-directory") mkdirSync(join(directory, "unexpected-directory"));
    if (tamper === "dependency-symlink") { renameSync(entry, `${entry}.original`); symlinkSync(`${entry}.original`, entry); }
  }
  for (const tamper of ["content", "owner-executable", "missing", "addition", "empty-directory", ...dependencyTampers, "digest-name", "legacy-name"]) {
    const changedRuntime = join(root, `overlay-${tamper}`);
    cpSync(runtime, changedRuntime, { recursive: true, verbatimSymlinks: true });
    const originalTarget = readlinkSync(join(changedRuntime, "previous"));
    const overlay = join(changedRuntime, originalTarget, "scripts", "collector-injector.mjs");
    if (tamper === "content") writeFileSync(overlay, `${readFileSync(overlay, "utf8")}// changed overlay\n`);
    if (tamper === "owner-executable") chmodSync(overlay, (lstatSync(overlay).mode & 0o777) ^ 0o100);
    if (tamper === "missing") rmSync(overlay);
    if (tamper === "addition") writeFileSync(join(changedRuntime, originalTarget, "scripts", "added-overlay.mjs"), "throw new Error('must never execute');\n");
    if (tamper === "empty-directory") mkdirSync(join(changedRuntime, originalTarget, "scripts", "unexpected-overlay"));
    if (dependencyTampers.includes(tamper)) alterDependency(changedRuntime, originalTarget, tamper);
    if (["digest-name", "legacy-name"].includes(tamper)) {
      const next = tamper === "legacy-name" ? `releases/compat-${firstSha}-00000000-0000-0000-0000-000000000000` : `${originalTarget.slice(0, -1)}${originalTarget.endsWith("0") ? "1" : "0"}`;
      renameSync(join(changedRuntime, originalTarget), join(changedRuntime, next));
      rmSync(join(changedRuntime, "previous"));
      symlinkSync(next, join(changedRuntime, "previous"));
    }
    const rejected = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", changedRuntime], { env, encoding: "utf8" });
    assert(rejected.status !== 0, `rollback rejects ${tamper} in compatibility identity`);
    assert(readlinkSync(join(changedRuntime, "current")) === thirdRelease, "compatibility rejection never changes current");
    if (tamper === "content") {
      const target = readlinkSync(join(changedRuntime, "previous")).slice("releases/".length);
      writeFileSync(join(changedRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "rollback", current: target, previous: thirdRelease.slice("releases/".length) }));
      const recovery = spawnSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", changedRuntime], { env, encoding: "utf8" });
      assert(recovery.status !== 0 && readlinkSync(join(changedRuntime, "current")) === thirdRelease, "journal recovery also rejects a changed compatibility overlay before pointer publication");
    }
  }
  for (const tamper of [...dependencyTampers, "digest-name", "sha-only-previous", "sha-only-journal"]) {
    const changedRuntime = join(root, `canonical-${tamper}`);
    cpSync(runtime, changedRuntime, { recursive: true, verbatimSymlinks: true });
    let target = thirdRelease;
    if (dependencyTampers.includes(tamper)) alterDependency(changedRuntime, target, tamper);
    if (tamper === "digest-name") {
      const next = `${target.slice(0, -1)}${target.endsWith("0") ? "1" : "0"}`;
      renameSync(join(changedRuntime, target), join(changedRuntime, next));
      rmSync(join(changedRuntime, "current")); symlinkSync(next, join(changedRuntime, "current"));
      target = next;
    }
    if (tamper === "sha-only-previous") {
      rmSync(join(changedRuntime, "previous")); symlinkSync(`releases/${firstSha}`, join(changedRuntime, "previous"));
    }
    if (["digest-name", "sha-only-journal"].includes(tamper)) writeFileSync(join(changedRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "rollback", current: tamper === "sha-only-journal" ? firstSha : target.slice("releases/".length), previous: readlinkSync(join(changedRuntime, "previous")).slice("releases/".length) }));
    const rejected = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", changedRuntime], { env, encoding: "utf8" });
    assert(rejected.status !== 0 && readlinkSync(join(changedRuntime, "current")) === target, `canonical release/recovery rejects ${tamper} before pointer changes`);
    assert(!existsSync(legacyMarker), "no rollback or journal path executes the unbound legacy dependency");
  }
  for (const boundary of ["journal", "current", "previous", "receipt", "journal-removal"]) {
    const crashRuntime = join(root, `rollback-crash-${boundary}`);
    cpSync(runtime, crashRuntime, { recursive: true, verbatimSymlinks: true });
    const crashHook = join(root, `rollback-crash-${boundary}.mjs`);
    writeFileSync(crashHook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.renameSync;
fs.renameSync = (source, target) => {
  const result = original(source, target);
  const home = ${JSON.stringify(crashRuntime)};
  if (target === home + '/${boundary === "receipt" ? "runtime-state.json" : boundary === "journal" ? ".transition.json" : boundary}' && (${JSON.stringify(boundary)} === 'journal' || fs.readlinkSync(home + '/current').startsWith('releases/compat-'))) process.exit(86);
  return result;
};
const originalRemove = fs.rmSync;
fs.rmSync = (path, options) => {
  const result = originalRemove(path, options);
  if (${JSON.stringify(boundary)} === 'journal-removal' && path === homePath) process.exit(86);
  return result;
};
const homePath = ${JSON.stringify(join(crashRuntime, ".transition.json"))};
syncBuiltinESMExports();\n`);
    const crashed = spawnSync(process.execPath, ["--import", crashHook, updater, "--rollback", "--runtime-root", crashRuntime], { env, encoding: "utf8" });
    assert(crashed.status === 86, `rollback exits at the ${boundary} publication boundary`);
    runnable(crashRuntime, "current");
    runnable(crashRuntime, "previous");
    const recovered = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", crashRuntime], { env, encoding: "utf8" });
    assert(recovered.status === 0, "repeated rollback recovers and reverses an interrupted rollback");
    assert(git(join(crashRuntime, "current"), ["rev-parse", "HEAD"]) === thirdSha && git(join(crashRuntime, "previous"), ["rev-parse", "HEAD"]) === firstSha, "rollback recovery preserves both distinct versions");
    runnable(crashRuntime, "current");
    runnable(crashRuntime, "previous");
    truthfulReceipt(crashRuntime);
    execFileSync(process.execPath, [updater, "--rollback", "--runtime-root", crashRuntime], { env });
    assert(git(join(crashRuntime, "current"), ["rev-parse", "HEAD"]) === firstSha && git(join(crashRuntime, "previous"), ["rev-parse", "HEAD"]) === thirdSha, "another rollback remains reversible after recovery and pruning");
    assert(readdirSync(join(crashRuntime, ".update.lock")).length === 0, "rollback recovery clears dead-owner locks");
  }
  for (const hidden of ["assume-unchanged", "skip-worktree", "filter", "executable-mode"]) {
    const changedRuntime = join(root, `tracked-${hidden}`);
    cpSync(runtime, changedRuntime, { recursive: true, verbatimSymlinks: true });
    const current = join(changedRuntime, "current");
    const script = "scripts/lib/infisical-service-token.mjs";
    if (["assume-unchanged", "skip-worktree"].includes(hidden)) git(current, ["update-index", `--${hidden}`, script]);
    if (hidden === "filter") {
      git(current, ["config", "filter.fixture.clean", "sed /fixture-hidden-change/d"]);
      mkdirSync(join(current, ".git", "info"), { recursive: true });
      writeFileSync(join(current, ".git", "info", "attributes"), `${script} filter=fixture\n`);
    }
    if (hidden === "executable-mode") chmodSync(join(current, script), (lstatSync(join(current, script)).mode & 0o777) ^ 0o111);
    else writeFileSync(join(current, script), `${readFileSync(join(current, script), "utf8")}// fixture-hidden-change\n`);
    if (hidden !== "executable-mode") git(current, ["diff", "--quiet", "HEAD", "--", script]);
    const rejected = spawnSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", changedRuntime], { env, encoding: "utf8" });
    assert(rejected.status !== 0 && rejected.stderr.includes("Release has modified tracked scripts"), `exact tracked validation rejects ${hidden} changes`);
  }
  for (const attack of ["replacement-ref", "corrupt-object", "root-self-resolution", "missing-root-manifest"]) {
    const changedRuntime = join(root, `git-resolution-${attack}`);
    cpSync(runtime, changedRuntime, { recursive: true, verbatimSymlinks: true });
    const previous = readlinkSync(join(changedRuntime, "previous"));
    const target = attack === "replacement-ref" ? previous : thirdRelease;
    const release = join(changedRuntime, target);
    const sentinel = join(root, `${attack}-executed`);
    const payload = `;(await import('node:fs')).writeFileSync(${JSON.stringify(sentinel)}, 'unsafe');\n`;
    if (attack === "replacement-ref") {
      const script = "scripts/lib/infisical-service-token.mjs";
      writeFileSync(join(release, script), `${readFileSync(join(release, script), "utf8")}${payload}`);
      git(release, ["add", script]);
      const tree = git(release, ["write-tree"]);
      const replacement = execFileSync("git", ["-C", release, "commit-tree", tree, "-p", firstSha], { encoding: "utf8", input: "replacement fixture\n", env: { ...process.env, GIT_AUTHOR_NAME: "Collector Test", GIT_AUTHOR_EMAIL: "collector-test@example.invalid", GIT_COMMITTER_NAME: "Collector Test", GIT_COMMITTER_EMAIL: "collector-test@example.invalid" } }).trim();
      git(release, ["update-ref", `refs/replace/${firstSha}`, replacement]);
      git(release, ["diff", "--quiet", "HEAD", "--", script]);
    }
    if (attack === "corrupt-object") {
      const object = git(release, ["rev-parse", `${thirdSha}:scripts/lib/infisical-service-token.mjs`]);
      const directory = join(release, ".git", "objects", object.slice(0, 2));
      mkdirSync(directory, { recursive: true });
      const bytes = Buffer.from("mismatched object storage\n");
      writeFileSync(join(directory, object.slice(2)), deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])));
    }
    if (attack === "root-self-resolution") {
      writeFileSync(join(release, "package.json"), JSON.stringify({ name: "zod", type: "module", exports: "./resolution-payload.mjs" }));
      writeFileSync(join(release, "resolution-payload.mjs"), payload);
    }
    if (attack === "missing-root-manifest") rmSync(join(release, "package.json"));
    for (const action of ["receipt", "recovery", "rollback", "activation"]) {
      if (action === "recovery") writeFileSync(join(changedRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "rollback", current: target.slice("releases/".length), previous: (target === thirdRelease ? previous : thirdRelease).slice("releases/".length) }));
      const args = action === "rollback" ? ["--rollback"] : ["--sha", thirdSha];
      const rejected = spawnSync(process.execPath, [updater, ...args, "--runtime-root", changedRuntime], { env, encoding: "utf8" });
      const reason = attack === "corrupt-object" ? "Release Git object integrity check failed" : attack === "missing-root-manifest" ? "Invalid tracked script file" : "Release has modified tracked scripts";
      assert(rejected.status !== 0 && rejected.stderr.includes(reason) && readlinkSync(join(changedRuntime, "current")) === thirdRelease && !existsSync(sentinel), `${action} rejects ${attack} without executing changed code`);
      if (action === "recovery") rmSync(join(changedRuntime, ".transition.json"));
    }
  }
  const hostileParent = join(root, "hostile-resolution-parent");
  const hostileRuntime = join(hostileParent, "runtime");
  cpSync(runtime, hostileRuntime, { recursive: true, verbatimSymlinks: true });
  const loaderSentinel = join(root, "hostile-loader-executed");
  const loader = join(hostileParent, "loader.mjs");
  writeFileSync(loader, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(loaderSentinel)}, 'unsafe'); throw new Error('hostile loader executed');\n`);
  writeFileSync(join(hostileParent, "package.json"), JSON.stringify({ name: "zod", type: "module", exports: "./loader.mjs" }));
  mkdirSync(join(hostileParent, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(hostileParent, "node_modules", "zod", "package.json"), JSON.stringify({ name: "zod", type: "module", exports: "./index.js" }));
  cpSync(loader, join(hostileParent, "node_modules", "zod", "index.js"));
  const hostileConfig = join(hostileParent, "gitconfig");
  writeFileSync(hostileConfig, `[core]\n\tworktree = ${hostileParent}\n[init]\n\ttemplateDir = ${hostileParent}\n`);
  const loaderHook = join(root, "inject-child-loader-settings.mjs");
  writeFileSync(loaderHook, `process.env.NODE_OPTIONS = ${JSON.stringify(`--import ${loader}`)}; process.env.NODE_PATH = ${JSON.stringify(join(hostileParent, "node_modules"))}; process.env.NODE_COMPILE_CACHE = ${JSON.stringify(join(hostileParent, "compile-cache"))};\n`);
  const hostileGitEnv = { ...env, GIT_DIR: join(source, ".git"), GIT_WORK_TREE: hostileParent, GIT_COMMON_DIR: join(source, ".git"), GIT_OBJECT_DIRECTORY: hostileParent, GIT_ALTERNATE_OBJECT_DIRECTORIES: hostileParent, GIT_CONFIG_GLOBAL: hostileConfig, GIT_CONFIG_SYSTEM: hostileConfig, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: hostileParent, GIT_REPLACE_REF_BASE: "refs/hostile/" };
  for (const action of ["activation", "recovery", "rollback"]) {
    if (action === "recovery") writeFileSync(join(hostileRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "forward", current: thirdRelease.slice("releases/".length), previous: readlinkSync(join(hostileRuntime, "previous")).slice("releases/".length) }));
    const args = action === "rollback" ? ["--rollback"] : ["--sha", thirdSha];
    const result = spawnSync(process.execPath, ["--import", loaderHook, updater, ...args, "--runtime-root", hostileRuntime], { env: hostileGitEnv, encoding: "utf8" });
    assert(result.status === 0 && !existsSync(loaderSentinel), `${action} ignores inherited Git/Node loader settings and hostile parent resolution`);
    truthfulReceipt(hostileRuntime);
  }
  git(source, ["reset", "--hard", secondSha]);
  const rewrittenMain = spawnSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(rewrittenMain.status !== 0 && rewrittenMain.stderr.includes("not an ancestor"), `cached canonical release is rejected after origin/main history rewrites: ${rewrittenMain.stderr}`);
  assert(readlinkSync(join(runtime, "current")) === thirdRelease, "ancestry rejection does not change active pointers");
  git(source, ["reset", "--hard", thirdSha]);
  const oldAfterRefresh = spawnSync(process.execPath, [updater, "--sha", firstSha, "--runtime-root", runtime], { env, encoding: "utf8" });
  assert(oldAfterRefresh.status !== 0 && readlinkSync(join(runtime, "current")) === thirdRelease, "refreshed overlay cannot forward-activate an old commit");
  const configuredLauncher = join(runtime, "current", "scripts", "collector-injector.mjs");
  const invalidLauncher = spawnSync(process.execPath, [configuredLauncher, "bad"], { encoding: "utf8" });
  assert(invalidLauncher.status !== 0, "symlinked configured launcher rejects invalid arguments");
  const custody = join(root, "custody.json");
  const marker = join(root, "login-reached");
  const hook = join(root, "mock-fetch.mjs");
  writeFileSync(custody, JSON.stringify({ clientId: "test-id", clientSecret: "test-sentinel-secret" }), { mode: 0o600 });
  writeFileSync(hook, "import { writeFileSync } from 'node:fs'; globalThis.fetch = async () => { writeFileSync(process.env.TEST_MARKER, 'reached'); return new Response('{}'); };\n");
  const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("INFISICAL_") && key !== "NODE_OPTIONS"));
  const mocked = spawnSync(process.execPath, ["--import", hook, configuredLauncher, "muse-code", "machine-identity", custody, "--dry-run"], { encoding: "utf8", env: { ...testEnv, TEST_MARKER: marker } });
  assert(mocked.status !== 0 && existsSync(marker), "symlinked launcher reaches mocked login after rollback");
  assert(!(mocked.stdout + mocked.stderr).includes("test-sentinel-secret"), "symlinked launcher never prints custody values");

  const invalid = spawnSync(
    process.execPath,
    [updater, "--sha", "0".repeat(40), "--runtime-root", join(root, "invalid")],
    { env, encoding: "utf8" },
  );
  assert(invalid.status !== 0, "unknown SHA rejected");
  const installed = join(root, "installed");
  mkdirSync(join(installed, "node_modules"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules", "zod"), join(installed, "node_modules", "zod"));
  execFileSync("bash", [join(repoRoot, "scripts", "install-collectors.sh")], { env: { ...process.env, UM_COLLECTORS_HOME: installed } });
  assert(existsSync(join(installed, "scripts", "telemetry-hub", "metadata-projection.mjs")), "installed runtime includes the bridge transport dependency graph");
  assert(existsSync(join(installed, "scripts", "collector-injector.mjs")), "installed runtime includes injector");
  assert(existsSync(join(installed, "scripts", "lib", "infisical-service-token.mjs")), "installed runtime includes verifier");
  assert(!existsSync(join(installed, "scripts", "telemetry-hub", "__tests__")), "transport test fixtures stay out of the installed runtime");
  console.log("ok local-collector-runtime");
} finally {
  rmSync(root, { recursive: true, force: true });
}
