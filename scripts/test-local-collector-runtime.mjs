#!/usr/bin/env node
import { execFileSync as rawExecFileSync, spawnSync as rawSpawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const CHILD_TIMEOUT_MS = 60_000;

function childOptions(options = {}) {
  const timeout = options.timeout ?? CHILD_TIMEOUT_MS;
  assert(Number.isSafeInteger(timeout) && timeout > 0, "Fixture children require a positive bounded timeout");
  return { ...options, timeout, killSignal: "SIGKILL" };
}

function childLabel(command, args) {
  const runtimeIndex = args.indexOf("--runtime-root");
  return `${basename(command)}${runtimeIndex >= 0 ? ` (${basename(args[runtimeIndex + 1])})` : ""}`;
}

function spawnSync(command, args, options = {}) {
  const bounded = childOptions(options);
  const result = rawSpawnSync(command, args, bounded);
  // A timeout has status null, which must never satisfy a tamper-rejection assertion.
  if (result.error?.code === "ETIMEDOUT") throw new Error(`Fixture child timed out after ${bounded.timeout}ms: ${childLabel(command, args)}`, { cause: result.error });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Fixture child terminated by ${result.signal}: ${childLabel(command, args)}`);
  return result;
}

function execFileSync(command, args, options = {}) {
  const bounded = childOptions(options);
  try { return rawExecFileSync(command, args, bounded); }
  catch (error) {
    if (error.code === "ETIMEDOUT") throw new Error(`Fixture child timed out after ${bounded.timeout}ms: ${childLabel(command, args)}`, { cause: error });
    throw error;
  }
}

let timeoutRejected = false;
try { spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 }); }
catch (error) { timeoutRejected = error.cause?.code === "ETIMEDOUT" && error.message.startsWith("Fixture child timed out"); }
assert(timeoutRejected, "a stalled child fails the fixture instead of passing an expected rejection");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "um-collector-runtime-")));
try {
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const updaterText = readFileSync(join(repoRoot, "scripts/update-local-collector-runtime.mjs"), "utf8");
  const definition = (start, end) => {
    const begin = updaterText.indexOf(start);
    const finish = updaterText.indexOf(end, begin + start.length);
    assert(begin >= 0 && finish > begin, "production lock definition is available to the fixture");
    return updaterText.slice(begin, finish);
  };
  const lockProgram = `const { execFileSync } = require('node:child_process');
const { readFileSync, lstatSync, mkdirSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path'); const { createHash, randomUUID } = require('node:crypto');
Object.defineProperty(process, 'platform', { value: 'darwin' });
${definition("function fail(", "function parseArgs(")}
${definition("function run(", "function repositoryUrl(")}
${definition("function stat(", "function releaseFromLink(")}
${definition("function processIdentity(", "function main(")}
`;
  const shortLockRoot = join(root, "short-darwin-lock");
  mkdirSync(shortLockRoot);
  const shortLock = spawnSync(process.execPath, ["-", "update-local-collector-runtime.mjs", "--rollback"], {
    argv0: "node", encoding: "utf8", input: `${lockProgram}
const home = ${JSON.stringify(shortLockRoot)};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const lock = join(home, '.update.lock'); mkdirSync(lock);
const live = join(lock, process.ppid + '-' + processIdentity(process.ppid) + '-' + randomUUID()); mkdirSync(live);
let activeRejected = false;
try { acquireLock(home); } catch (error) { activeRejected = error.message === 'Another collector runtime update is active'; }
assert(activeRejected && readdirSync(lock).length === 1, 'short argv preserves a live owner'); rmSync(live, { recursive: true });
const release = acquireLock(home);
const own = readdirSync(lock)[0]; const nonce = own.slice(-36);
assert(process.title.startsWith(nonce), 'the full UUID survives short-argv truncation');
const firstIdentity = processIdentity(process.pid); process.title = randomUUID() + ' um-collector-updater';
assert(processIdentity(process.pid) !== firstIdentity, 'same PID and birth time with a different full nonce has a different identity');
release(); mkdirSync(join(lock, own));
const releaseNext = acquireLock(home);
assert(readdirSync(lock).length === 1 && readdirSync(lock)[0] !== own, 'a same-start stale nonce owner is reclaimed');
releaseNext(); assert(readdirSync(lock).length === 0, 'verified owner cleanup preserves lock state');
console.log('ok short-darwin-lock');
` });
  assert(shortLock.status === 0 && shortLock.stdout.includes("ok short-darwin-lock"), `production Darwin lock functions preserve nonce and PID-reuse safety under short argv: ${shortLock.stderr}`);
  const tinyLockRoot = join(root, "undersized-darwin-lock");
  mkdirSync(tinyLockRoot);
  const tinyLock = spawnSync(process.execPath, ["-"], { argv0: "n", encoding: "utf8", input: `${lockProgram}\nacquireLock(${JSON.stringify(tinyLockRoot)});` });
  assert(tinyLock.status !== 0 && tinyLock.stderr.includes("Cannot verify updater process nonce") && readdirSync(join(tinyLockRoot, ".update.lock")).length === 0, "an argv buffer too small for the complete UUID fails closed before publishing an owner");
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

  const fsckCountHook = join(root, "fsck-count-hook.mjs");
  const fsckCountFile = join(root, "fsck-count.json");
  writeFileSync(fsckCountHook, `import cp from 'node:child_process'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = cp.execFileSync;
let count = 0;
cp.execFileSync = (command, args, ...rest) => {
  if (command === '/usr/bin/git' && args.includes('fsck')) count++;
  return original(command, args, ...rest);
};
process.on('exit', () => fs.writeFileSync(${JSON.stringify(fsckCountFile)}, JSON.stringify(count)));
syncBuiltinESMExports();\n`);
  for (const [action, limit] of [["activation", 18], ["rollback", 14]]) {
    const home = join(root, `fsck-count-${action}`);
    cpSync(runtime, home, { recursive: true, verbatimSymlinks: true });
    const args = action === "activation" ? ["--sha", thirdSha] : ["--rollback"];
    const counted = spawnSync(process.execPath, ["--import", fsckCountHook, updater, ...args, "--runtime-root", home], { env, encoding: "utf8" });
    assert(counted.status === 0, `bounded-count ${action} succeeds: ${counted.stderr}`);
    const count = JSON.parse(readFileSync(fsckCountFile, "utf8"));
    assert(Number.isSafeInteger(count) && count > 0 && count <= limit, `${action} performs at most ${limit} integrity scans for the controlled bound-release fixture; observed ${count}`);
    const expectedCurrent = action === "activation" ? thirdSha : firstSha;
    const expectedPrevious = action === "activation" ? firstSha : thirdSha;
    assert(git(join(home, "current"), ["rev-parse", "HEAD"]) === expectedCurrent && git(join(home, "previous"), ["rev-parse", "HEAD"]) === expectedPrevious, "scan-count optimization preserves release direction");
    const receipt = JSON.parse(readFileSync(join(home, "runtime-state.json"), "utf8"));
    assert(receipt.currentSha === expectedCurrent && receipt.previousSha === expectedPrevious, "scan-count operation writes a truthful receipt");
    console.log(JSON.stringify({ fixture: "fsck-count-bound", action, count, limit }));
  }

  const memoryRuntime = join(root, "streamed-dependency-digest");
  const memoryHook = join(root, "streamed-dependency-digest.mjs");
  const memoryStats = join(root, "streamed-dependency-digest.json");
  writeFileSync(memoryHook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const home = ${JSON.stringify(memoryRuntime)};
const originalRename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (target.startsWith(home + '/releases/') && target.endsWith('/node_modules/zod')) {
    const padding = source + '/fixture-padding';
    fs.mkdirSync(padding);
    const bytes = Buffer.alloc(256 * 1024, 97);
    for (let index = 0; index < 64; index++) fs.writeFileSync(padding + '/' + index + '.bin', bytes);
  }
  return originalRename(source, target);
};
const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync, originalDirectory = fs.readdirSync;
const owned = new Set();
let shared, reused = true, maxBuffer = 0, totalBytes = 0;
fs.readdirSync = (path, ...args) => {
  if (typeof path === 'string' && path.startsWith(home + '/releases/') && path.endsWith('/node_modules')) shared = undefined;
  return originalDirectory(path, ...args);
};
fs.openSync = (path, flags, ...args) => {
  const fd = originalOpen(path, flags, ...args);
  if (typeof path === 'string' && path.startsWith(home + '/releases/') && path.includes('/node_modules/zod/') && typeof flags === 'number' && (flags & fs.constants.O_NOFOLLOW) && (flags & fs.constants.O_NONBLOCK)) owned.add(fd);
  return fd;
};
fs.readSync = (fd, buffer, ...args) => {
  const count = originalRead(fd, buffer, ...args);
  if (owned.has(fd)) {
    reused = reused && (shared === undefined || shared === buffer);
    shared = buffer;
    maxBuffer = Math.max(maxBuffer, buffer.length);
    totalBytes += count;
  }
  return count;
};
fs.closeSync = (fd) => { owned.delete(fd); return originalClose(fd); };
process.on('exit', () => fs.writeFileSync(${JSON.stringify(memoryStats)}, JSON.stringify({ reused, maxBuffer, totalBytes, openFiles: owned.size })));
syncBuiltinESMExports();\n`);
  const memoryResult = spawnSync(process.execPath, ["--import", memoryHook, updater, "--sha", thirdSha, "--runtime-root", memoryRuntime], { env, encoding: "utf8" });
  assert(memoryResult.status === 0, `streamed dependency fixture activates: ${memoryResult.stderr}`);
  const streamStats = JSON.parse(readFileSync(memoryStats, "utf8"));
  assert(streamStats.reused && streamStats.maxBuffer > 0 && streamStats.maxBuffer <= 64 * 1024 && streamStats.totalBytes >= 16 * 1024 * 1024 && streamStats.openFiles === 0, "dependency digests reuse one bounded buffer per pass and close every verified descriptor for a padded tree");
  const memoryRelease = readlinkSync(join(memoryRuntime, "current"));
  const referenceEntries = [];
  function referenceWalk(name) {
    const path = join(memoryRuntime, memoryRelease, name);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let info;
    try {
      info = fstatSync(fd);
      assert(info.isDirectory() || info.isFile(), "reference digest requires a directory or regular file");
      referenceEntries.push({ name, directory: info.isDirectory(), executable: Boolean(info.mode & 0o100), bytes: info.isDirectory() ? Buffer.alloc(0) : readFileSync(fd) });
    } finally { closeSync(fd); }
    if (info.isDirectory()) for (const entry of readdirSync(path)) referenceWalk(`${name}/${entry}`);
  }
  referenceWalk("node_modules/zod");
  const referenceHash = createHash("sha256");
  function referenceField(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    referenceHash.update(size).update(bytes);
  }
  for (const value of ["usage-monitor-runtime-release-v1", "canonical", thirdSha, String(referenceEntries.length)]) referenceField(value);
  for (const entry of referenceEntries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    for (const value of [entry.name, entry.directory ? "directory" : "file", entry.executable ? "100755" : "100644", entry.bytes]) referenceField(value);
  }
  assert(memoryRelease === `releases/release-${thirdSha}-${referenceHash.digest("hex")}`, "streamed dependency bytes preserve the previous buffered content-identity format exactly");

  const lateCorruptionRuntime = join(root, "late-git-object-corruption");
  cpSync(runtime, lateCorruptionRuntime, { recursive: true, verbatimSymlinks: true });
  const lateCorruptionRelease = join(lateCorruptionRuntime, thirdRelease);
  const lateObject = git(lateCorruptionRelease, ["rev-parse", `${thirdSha}:scripts/lib/infisical-service-token.mjs`]);
  const lateCorruptionHook = join(root, "late-git-object-corruption.mjs");
  const lateCorruptionMarker = join(root, "late-git-object-corrupted");
  writeFileSync(lateCorruptionHook, `import cp from 'node:child_process'; import fs from 'node:fs'; import { deflateSync } from 'node:zlib'; import { syncBuiltinESMExports } from 'node:module';
const original = cp.execFileSync;
cp.execFileSync = (command, args, ...rest) => {
  const result = original(command, args, ...rest);
  if (command === '/usr/bin/git' && args.includes('fsck') && args.includes(${JSON.stringify(lateCorruptionRelease)}) && !fs.existsSync(${JSON.stringify(lateCorruptionMarker)})) {
    const directory = ${JSON.stringify(join(lateCorruptionRelease, ".git", "objects", lateObject.slice(0, 2)))};
    fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from('object changed after a successful integrity check\\n');
    fs.writeFileSync(directory + '/${lateObject.slice(2)}', deflateSync(Buffer.concat([Buffer.from('blob ' + bytes.length + '\\0'), bytes])));
    fs.writeFileSync(${JSON.stringify(lateCorruptionMarker)}, 'changed');
  }
  return result;
}; syncBuiltinESMExports();\n`);
  const lateCorruption = spawnSync(process.execPath, ["--import", lateCorruptionHook, updater, "--rollback", "--runtime-root", lateCorruptionRuntime], { env, encoding: "utf8" });
  assert(lateCorruption.status !== 0 && lateCorruption.stderr.includes("Release Git object integrity check failed") && existsSync(lateCorruptionMarker), "a later use boundary rechecks object integrity after an earlier successful fsck");
  assert(readlinkSync(join(lateCorruptionRuntime, "current")) === thirdRelease && readlinkSync(join(lateCorruptionRuntime, "previous")) === readlinkSync(join(runtime, "previous")) && !existsSync(join(lateCorruptionRuntime, ".transition.json")), "late Git corruption fails before publishing either pointer or a transition");

  function legacyLinksFixture(home, bothLegacy = false) {
    cpSync(runtime, home, { recursive: true, verbatimSymlinks: true });
    rmSync(join(home, "previous"));
    symlinkSync(`releases/${firstSha}`, join(home, "previous"));
    const fifo = join(home, "releases", firstSha, "node_modules", "zod", "hostile.fifo");
    execFileSync("mkfifo", [fifo]);
    if (bothLegacy) {
      const current = join(home, "releases", secondSha);
      execFileSync("git", ["clone", "--quiet", source, current]);
      git(current, ["checkout", "--quiet", "--detach", secondSha]);
      const hostileModules = join(root, `${home.split("/").pop()}-unbound-modules`);
      mkdirSync(join(hostileModules, "zod"), { recursive: true });
      writeFileSync(join(hostileModules, "zod", "package.json"), '{"type":"module"}\n');
      writeFileSync(join(hostileModules, "zod", "index.js"), legacyBytes);
      symlinkSync(hostileModules, join(current, "node_modules"));
      rmSync(join(home, "current"));
      symlinkSync(`releases/${secondSha}`, join(home, "current"));
    }
    return () => {
      assert(!existsSync(legacyMarker), "legacy-link migration never executes unbound dependencies");
      assert(readFileSync(join(home, "releases", firstSha, "node_modules", "zod", "index.js"), "utf8") === legacyBytes, "legacy previous dependency bytes remain unchanged");
      assert(lstatSync(fifo).isFIFO(), "legacy previous special files are preserved without traversal");
      if (bothLegacy) assert(lstatSync(join(home, "releases", secondSha, "node_modules")).isSymbolicLink(), "legacy current dependency symlink remains untouched");
    };
  }

  for (const action of ["activation", "rollback", "two-legacy-rollback"]) {
    const home = join(root, `legacy-links-${action}`);
    const preserved = legacyLinksFixture(home, action === "two-legacy-rollback");
    const args = action === "activation" ? ["--sha", thirdSha] : ["--rollback"];
    const migrated = spawnSync(process.execPath, [updater, ...args, "--runtime-root", home], { env, encoding: "utf8" });
    assert(migrated.status === 0, `existing bare-SHA previous migrates before ${action}: ${migrated.stderr}`);
    const expectedCurrent = action === "activation" ? thirdSha : firstSha;
    const expectedPrevious = action === "two-legacy-rollback" ? secondSha : action === "activation" ? firstSha : thirdSha;
    assert(git(join(home, "current"), ["rev-parse", "HEAD"]) === expectedCurrent && git(join(home, "previous"), ["rev-parse", "HEAD"]) === expectedPrevious, "migration preserves the requested update or rollback direction");
    assert(!/^[a-f0-9]{40}$/.test(readlinkSync(join(home, "current")).slice("releases/".length)) && !/^[a-f0-9]{40}$/.test(readlinkSync(join(home, "previous")).slice("releases/".length)), "both published links use bound identities after migration");
    runnable(home, "current");
    runnable(home, "previous");
    truthfulReceipt(home);
    preserved();
    if (action !== "activation") {
      const reverse = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", home], { env, encoding: "utf8" });
      assert(reverse.status === 0 && git(join(home, "current"), ["rev-parse", "HEAD"]) === expectedPrevious && git(join(home, "previous"), ["rev-parse", "HEAD"]) === expectedCurrent, "another rollback reverses the migrated pair without activating the donor");
      preserved();
    }
  }

  writeFileSync(join(source, "scripts", "collector-injector.mjs"), `${secondInjector.toString()}\nimport './lib/collector-overlay-only.mjs';\n`);
  git(source, ["add", "scripts/collector-injector.mjs"]);
  git(source, ["commit", "-m", "latest donor incompatible with legacy source"]);
  const incompatibleLatestSha = git(source, ["rev-parse", "HEAD"]);
  const historicalHome = join(root, "historical-rollback-donor");
  const historicalPreserved = legacyLinksFixture(historicalHome, true);
  const historicalRollback = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", historicalHome], { env, encoding: "utf8" });
  assert(historicalRollback.status === 0 && git(join(historicalHome, "current"), ["rev-parse", "HEAD"]) === firstSha && git(join(historicalHome, "previous"), ["rev-parse", "HEAD"]) === secondSha, "rollback uses a compatible approved historical donor when latest is incompatible");
  assert(git(join(historicalHome, "current"), ["rev-parse", "HEAD"]) !== incompatibleLatestSha, "bootstrap donor never becomes the rollback target");
  historicalPreserved();

  git(source, ["checkout", "-b", "legacy-donor-history", firstSha]);
  writeFileSync(join(source, "scripts", "copilot-usage-collector.mjs"), `${readFileSync(join(source, "scripts", "copilot-usage-collector.mjs"), "utf8")}\n// second pre-injector historical version\n`);
  git(source, ["add", "scripts/copilot-usage-collector.mjs"]);
  git(source, ["commit", "-m", "second pre-injector historical version"]);
  const otherLegacySha = git(source, ["rev-parse", "HEAD"]);
  git(source, ["checkout", "main"]);
  git(source, ["merge", "--no-ff", "legacy-donor-history", "-m", "approve historical donor branch"]);
  const pinnedHome = join(root, "pinned-rollback-donor");
  const pinnedPreserved = legacyLinksFixture(pinnedHome);
  const otherLegacyPath = join(pinnedHome, "releases", otherLegacySha);
  execFileSync("git", ["clone", "--quiet", source, otherLegacyPath]);
  git(otherLegacyPath, ["checkout", "--quiet", "--detach", otherLegacySha]);
  symlinkSync(join(pinnedHome, "releases", firstSha, "node_modules"), join(otherLegacyPath, "node_modules"));
  rmSync(join(pinnedHome, "current"));
  rmSync(join(pinnedHome, "previous"));
  symlinkSync(`releases/${firstSha}`, join(pinnedHome, "current"));
  symlinkSync(`releases/${otherLegacySha}`, join(pinnedHome, "previous"));
  const noDonor = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", pinnedHome], { env, encoding: "utf8" });
  assert(noDonor.status !== 0 && noDonor.stderr.includes("No compatible approved migration donor"), "incompatible automatic donors fail explicitly");
  assert(readlinkSync(join(pinnedHome, "current")) === `releases/${firstSha}` && readlinkSync(join(pinnedHome, "previous")) === `releases/${otherLegacySha}` && !existsSync(join(pinnedHome, ".transition.json")), "all failed donor candidates preserve links and journal state");
  const pinned = spawnSync(process.execPath, [updater, "--rollback", "--migration-donor-sha", secondSha, "--runtime-root", pinnedHome], { env, encoding: "utf8" });
  assert(pinned.status === 0 && git(join(pinnedHome, "current"), ["rev-parse", "HEAD"]) === otherLegacySha && git(join(pinnedHome, "previous"), ["rev-parse", "HEAD"]) === firstSha, "an explicit approved compatible donor migrates two pre-injector versions without activating itself");
  pinnedPreserved();
  assert(lstatSync(join(otherLegacyPath, "node_modules")).isSymbolicLink(), "pinned migration leaves the other legacy dependency link untouched");
  const unapprovedPinHome = join(root, "unapproved-migration-donor");
  const unapprovedPreserved = legacyLinksFixture(unapprovedPinHome, true);
  const unapprovedPin = spawnSync(process.execPath, [updater, "--rollback", "--migration-donor-sha", "f".repeat(40), "--runtime-root", unapprovedPinHome], { env, encoding: "utf8" });
  assert(unapprovedPin.status !== 0 && unapprovedPin.stderr.includes("not an ancestor") && readlinkSync(join(unapprovedPinHome, "current")) === `releases/${secondSha}` && readlinkSync(join(unapprovedPinHome, "previous")) === `releases/${firstSha}`, "an unapproved explicit pin fails without falling back or changing either version");
  unapprovedPreserved();
  git(source, ["reset", "--hard", thirdSha]);

  for (const attack of ["modified-tracked-source", "unapproved-commit", "incompatible-donor"]) {
    const home = join(root, `legacy-migration-${attack}`);
    const preserved = legacyLinksFixture(home, attack === "incompatible-donor");
    const previous = join(home, "previous");
    let requested = thirdSha;
    if (attack === "modified-tracked-source") writeFileSync(join(previous, "scripts", "lib", "infisical-service-token.mjs"), "throw new Error('changed tracked source');\n");
    if (attack === "unapproved-commit") {
      git(previous, ["config", "user.name", "Collector Test"]);
      git(previous, ["config", "user.email", "collector-test@example.invalid"]);
      git(previous, ["commit", "--allow-empty", "-m", "unapproved legacy commit"]);
      const rogueSha = git(previous, ["rev-parse", "HEAD"]);
      renameSync(join(home, "releases", firstSha), join(home, "releases", rogueSha));
      rmSync(previous);
      symlinkSync(`releases/${rogueSha}`, previous);
    }
    if (attack === "incompatible-donor") {
      writeFileSync(join(source, "scripts", "collector-injector.mjs"), `${secondInjector.toString()}\nimport './lib/collector-overlay-only.mjs';\n`);
      git(source, ["add", "scripts/collector-injector.mjs"]);
      git(source, ["commit", "-m", "incompatible migration donor"]);
      requested = git(source, ["rev-parse", "HEAD"]);
    }
    const currentBefore = readlinkSync(join(home, "current"));
    const previousBefore = readlinkSync(previous);
    const refused = spawnSync(process.execPath, [updater, "--sha", requested, "--runtime-root", home], { env, encoding: "utf8" });
    assert(refused.status !== 0 && !existsSync(join(home, ".transition.json")), `legacy migration rejects ${attack} before journaling`);
    assert(readlinkSync(join(home, "current")) === currentBefore && readlinkSync(previous) === previousBefore && !existsSync(legacyMarker), "failed migration preserves both original links without executing legacy code");
    if (attack === "modified-tracked-source") assert(refused.stderr.includes("modified tracked scripts"), "modified legacy tracked source is identified");
    if (attack === "unapproved-commit") assert(refused.stderr.includes("not an ancestor"), "unapproved legacy commit cannot become a trusted compatibility tree");
    if (attack === "incompatible-donor") {
      assert(refused.stderr.includes("collector-overlay-only.mjs"), "cross-version donor import failure is identified");
      preserved();
      git(source, ["reset", "--hard", thirdSha]);
    }
  }

  for (const boundary of ["dependency", "compatibility", "overlay", "journal", "previous", "current", "receipt", "journal-removal"]) {
    const home = join(root, `legacy-migration-crash-${boundary}`);
    const preserved = legacyLinksFixture(home, true);
    const hook = join(root, `legacy-migration-crash-${boundary}.mjs`);
    writeFileSync(hook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const home = ${JSON.stringify(home)};
const boundary = ${JSON.stringify(boundary)};
const originalRename = fs.renameSync;
fs.renameSync = (source, target) => {
  const result = originalRename(source, target);
  if ((boundary === 'dependency' && target.startsWith(home + '/releases/') && target.endsWith('/node_modules/zod')) ||
      (boundary === 'compatibility' && target.startsWith(home + '/releases/compat-')) ||
      (boundary === 'journal' && target === home + '/.transition.json') ||
      (boundary === 'previous' && target === home + '/previous') ||
      (boundary === 'current' && target === home + '/current') ||
      (boundary === 'receipt' && target === home + '/runtime-state.json')) process.exit(86);
  return result;
};
const originalCopy = fs.copyFileSync;
fs.copyFileSync = (source, target, ...args) => {
  const result = originalCopy(source, target, ...args);
  if (boundary === 'overlay' && target.startsWith(home + '/releases/.compat-stage-') && target.endsWith('/scripts/collector-injector.mjs')) process.exit(86);
  return result;
};
const originalRemove = fs.rmSync;
fs.rmSync = (path, ...args) => {
  const result = originalRemove(path, ...args);
  if (boundary === 'journal-removal' && path === home + '/.transition.json') process.exit(86);
  return result;
}; syncBuiltinESMExports();\n`);
    const crashed = spawnSync(process.execPath, ["--import", hook, updater, "--rollback", "--runtime-root", home], { env, encoding: "utf8" });
    assert(crashed.status === 86, `legacy migration exits at the ${boundary} boundary`);
    assert(git(join(home, "current"), ["rev-parse", "HEAD"]) === secondSha && git(join(home, "previous"), ["rev-parse", "HEAD"]) === firstSha, "interrupted identity migration never reverses the logical release pair");
    preserved();
    if (existsSync(join(home, ".transition.json"))) {
      const journal = JSON.parse(readFileSync(join(home, ".transition.json"), "utf8"));
      assert(journal.kind === "migration" && /^compat-[a-f0-9]{40}-[a-f0-9]{64}$/.test(journal.current) && /^compat-[a-f0-9]{40}-[a-f0-9]{64}$/.test(journal.previous), "migration journal contains only bound compatibility identities");
    }
    const recovered = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", home], { env, encoding: "utf8" });
    assert(recovered.status === 0 && git(join(home, "current"), ["rev-parse", "HEAD"]) === firstSha && git(join(home, "previous"), ["rev-parse", "HEAD"]) === secondSha, `recovery completes migration then applies one rollback after ${boundary}`);
    runnable(home, "current");
    runnable(home, "previous");
    truthfulReceipt(home);
    preserved();
    assert(!existsSync(join(home, ".transition.json")) && readdirSync(join(home, ".update.lock")).length === 0, "migration recovery clears journal and dead-owner locks");
    assert(!readdirSync(join(home, "releases")).some((name) => name.startsWith(".")), "migration recovery prunes abandoned clean-source and compatibility stages");
  }

  const dependencyTampers = ["dependency-content", "dependency-addition", "dependency-removal", "dependency-mode", "dependency-directory", "dependency-symlink", "dependency-oversize"];
  function alterDependency(home, target, tamper) {
    const directory = join(home, target, "node_modules", "zod");
    const entry = join(directory, "index.js");
    if (tamper === "dependency-content") writeFileSync(entry, `${readFileSync(entry, "utf8")}// changed dependency\n`);
    if (tamper === "dependency-addition") writeFileSync(join(directory, "added.mjs"), "export {};\n");
    if (tamper === "dependency-removal") rmSync(entry);
    if (tamper === "dependency-mode") chmodSync(entry, (lstatSync(entry).mode & 0o777) ^ 0o100);
    if (tamper === "dependency-directory") mkdirSync(join(directory, "unexpected-directory"));
    if (tamper === "dependency-symlink") { renameSync(entry, `${entry}.original`); symlinkSync(`${entry}.original`, entry); }
    if (tamper === "dependency-oversize") truncateSync(entry, 8 * 1024 * 1024 + 1);
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
    if (tamper === "dependency-oversize") assert(rejected.stderr.includes("bounded file size"), "oversized compatibility dependency is rejected before reading");
    assert(readlinkSync(join(changedRuntime, "current")) === thirdRelease, "compatibility rejection never changes current");
    if (tamper === "content") {
      const target = readlinkSync(join(changedRuntime, "previous")).slice("releases/".length);
      writeFileSync(join(changedRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "rollback", current: target, previous: thirdRelease.slice("releases/".length) }));
      const recovery = spawnSync(process.execPath, [updater, "--sha", thirdSha, "--runtime-root", changedRuntime], { env, encoding: "utf8" });
      assert(recovery.status !== 0 && readlinkSync(join(changedRuntime, "current")) === thirdRelease, "journal recovery also rejects a changed compatibility overlay before pointer publication");
    }
  }
  for (const tamper of [...dependencyTampers, "digest-name", "sha-only-journal"]) {
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
    if (["digest-name", "sha-only-journal"].includes(tamper)) writeFileSync(join(changedRuntime, ".transition.json"), JSON.stringify({ version: 1, kind: "rollback", current: tamper === "sha-only-journal" ? firstSha : target.slice("releases/".length), previous: readlinkSync(join(changedRuntime, "previous")).slice("releases/".length) }));
    const rejected = spawnSync(process.execPath, [updater, "--rollback", "--runtime-root", changedRuntime], { env, encoding: "utf8" });
    assert(rejected.status !== 0 && readlinkSync(join(changedRuntime, "current")) === target, `canonical release/recovery rejects ${tamper} before pointer changes`);
    if (tamper === "dependency-oversize") assert(rejected.stderr.includes("bounded file size"), "oversized canonical dependency is rejected before reading");
    assert(!existsSync(legacyMarker), "no rollback or journal path executes the unbound legacy dependency");
  }
  const raceRuntime = join(root, "dependency-file-race");
  cpSync(runtime, raceRuntime, { recursive: true, verbatimSymlinks: true });
  const raceTarget = join(raceRuntime, readlinkSync(join(raceRuntime, "previous")), "node_modules", "zod", "index.js");
  const raceExternal = join(root, "dependency-race-external.mjs");
  const raceSwapped = join(root, "dependency-race-swapped");
  const raceRead = join(root, "dependency-race-unsafe-read");
  const raceHook = join(root, "dependency-race-hook.mjs");
  writeFileSync(raceExternal, "throw new Error('external race target must not be read');\n");
  writeFileSync(raceHook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(raceTarget)};
const originalStat = fs.lstatSync;
const originalRead = fs.readFileSync;
fs.lstatSync = (path, ...args) => {
  const info = originalStat(path, ...args);
  if (path === target && !fs.existsSync(${JSON.stringify(raceSwapped)})) {
    fs.renameSync(target, target + '.original');
    fs.symlinkSync(${JSON.stringify(raceExternal)}, target);
    fs.writeFileSync(${JSON.stringify(raceSwapped)}, 'swapped');
  }
  return info;
};
fs.readFileSync = (path, ...args) => {
  if (path === target) fs.writeFileSync(${JSON.stringify(raceRead)}, 'unsafe pathname read');
  return originalRead(path, ...args);
}; syncBuiltinESMExports();\n`);
  const raced = spawnSync(process.execPath, ["--import", raceHook, updater, "--rollback", "--runtime-root", raceRuntime], { env, encoding: "utf8" });
  assert(raced.status !== 0 && raced.stderr.includes("ELOOP") && existsSync(raceSwapped), "dependency symlink replacement after lstat is rejected by the descriptor open");
  assert(!existsSync(raceRead) && readlinkSync(join(raceRuntime, "current")) === thirdRelease, "dependency race never reads the pathname target or changes current");

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
