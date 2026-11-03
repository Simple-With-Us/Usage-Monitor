import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, cpSync, existsSync, fstatSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, opendirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkCollectorInstall } from "./check-collector-install.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
function git(source, args) {
  return execFileSync("/usr/bin/git", ["-C", source, ...args], { encoding: "utf8", stdio: "pipe", timeout: 10000 }).trim();
}
function fixture(check, { temporaryRoot = tmpdir() } = {}) {
  const root = realpathSync(mkdtempSync(join(temporaryRoot, "collector-install-preflight-")));
  const source = join(root, "source");
  const destination = join(root, "installed");
  mkdirSync(join(source, "scripts", "lib"), { recursive: true });
  mkdirSync(join(source, "scripts", "telemetry-hub"));
  writeFileSync(join(source, "package.json"), '{"dependencies":{"zod":"^4.6.6"}}\n');
  writeFileSync(join(source, "scripts", "grok-usage-collector.mjs"), "export const original = true;\n");
  writeFileSync(join(source, "scripts", "lib", "shared.mjs"), "export {};\n");
  writeFileSync(join(source, "scripts", "telemetry-hub", "transport.mjs"), "export {};\n");
  cpSync(join(scripts, "install-collectors.sh"), join(source, "scripts", "install-collectors.sh"));
  cpSync(join(scripts, "check-collector-install.mjs"), join(source, "scripts", "check-collector-install.mjs"));
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.name", "Collector Fixture"]);
  git(source, ["config", "user.email", "collector-fixture@example.invalid"]);
  const commit = () => { git(source, ["add", "."]); git(source, ["commit", "--quiet", "-m", "Collector Fixture"]); return git(source, ["rev-parse", "HEAD"]); };
  const baseline = commit();
  mkdirSync(join(destination, "scripts"), { recursive: true });
  for (const name of ["grok-usage-collector.mjs", "lib", "telemetry-hub"]) cpSync(join(source, "scripts", name), join(destination, "scripts", name), { recursive: true });
  writeFileSync(join(destination, "VERSION"), `sha=${baseline}\ninstalled=fixture\n`);
  const update = () => { writeFileSync(join(source, "scripts", "grok-usage-collector.mjs"), "export const idleDrain = true;\n"); return commit(); };
  try { return check({ root, source, destination, baseline, commit, update }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

// Compare quiescent trees under fixture()'s private root; pathname-based child
// lookup requires frozen ancestors and is not an adversarial whole-tree snapshot.
function snapshot(path, afterDirectoryOpen) {
  try { return { link: readlinkSync(path) }; }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code !== "EINVAL") throw error;
  }
  let directory;
  try { directory = opendirSync(path); }
  catch (error) { if (error.code !== "ENOTDIR") throw error; }
  if (directory) {
    try {
      afterDirectoryOpen?.(directory);
      const names = [];
      for (let entry; (entry = directory.readSync()) !== null;) names.push(entry.name);
      return Object.fromEntries(names.sort().map(name => [name, snapshot(join(path, name))]));
    } finally { directory.closeSync(); }
  }
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (["ENXIO", "ENODEV", "EOPNOTSUPP"].includes(error.code)) {
      const kind = lstatSync(path);
      if (kind.isSocket() || kind.isBlockDevice() || kind.isCharacterDevice()) return { special: true };
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { special: true };
    return { bytes: readFileSync(fd, "utf8"), mode: opened.mode };
  } finally { closeSync(fd); }
}

function installerRefuses({ root, source, destination }, pattern, preflightOutput) {
  const before = snapshot(destination);
  const bin = join(root, "guard-bin"); mkdirSync(bin);
  const marker = join(root, "unexpected-install-write");
  for (const name of ["rsync", "npm"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nprintf invoked >> \"$FIXTURE_MUTATION_MARKER\"\nexit 99\n"); chmodSync(path, 0o700);
  }
  if (preflightOutput !== undefined) {
    const node = join(bin, "node");
    writeFileSync(node, "#!/bin/sh\nprintf '%s' \"$FIXTURE_PREFLIGHT_OUTPUT\"\n"); chmodSync(node, 0o700);
  }
  const result = spawnSync("bash", [join(source, "scripts", "install-collectors.sh")], { encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, UM_COLLECTORS_HOME: destination, FIXTURE_MUTATION_MARKER: marker, FIXTURE_PREFLIGHT_OUTPUT: preflightOutput } });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(snapshot(destination), before, "refusal preserves scripts, dependency metadata and receipt state");
}

test("a pristine prior tracked graph may refresh without mutating during preflight", () => fixture(({ source, destination, update }) => {
  const before = readFileSync(join(destination, "scripts", "grok-usage-collector.mjs"));
  const sha = update();
  assert.deepEqual(checkCollectorInstall(source, destination), { sourceSha: sha, zodSpec: "^4.6.6", installDependencies: true, checked: 3 });
  assert.deepEqual(readFileSync(join(destination, "scripts", "grok-usage-collector.mjs")), before);
}));

test("fresh targets and unchanged reinstall require no fabricated baseline", () => fixture(({ root, source, destination }) => {
  assert.equal(checkCollectorInstall(source, join(root, "fresh")).checked, 0);
  rmSync(join(destination, "VERSION"));
  assert.equal(checkCollectorInstall(source, destination).checked, 3);
}));

test("an independently modified collector is retained when canonical source advances", () => fixture(({ source, destination, update }) => {
  update();
  const path = join(destination, "scripts", "grok-usage-collector.mjs");
  const independent = "import './lib/purpose-bound.mjs';\nexport const original = true;\n";
  writeFileSync(path, independent);
  assert.throws(() => checkCollectorInstall(source, destination), /Preserving independently modified/);
  assert.equal(readFileSync(path, "utf8"), independent);
}));

test("an untracked installed purpose-bound helper is preserved", () => fixture(({ source, destination }) => {
  const path = join(destination, "scripts", "lib", "purpose-bound.mjs");
  writeFileSync(path, "export const purposeBound = true;\n");
  assert.throws(() => checkCollectorInstall(source, destination), /Preserving unrecognized installed collector helper/);
  assert.equal(readFileSync(path, "utf8"), "export const purposeBound = true;\n");
}));

for (const kind of ["untracked", "modified", "missing"]) test(`incoming ${kind} managed source fails closed`, () => fixture(({ source, destination }) => {
  if (kind === "untracked") writeFileSync(join(source, "scripts", "lib", "purpose-bound.mjs"), "export {};\n");
  if (kind === "modified") writeFileSync(join(source, "scripts", "grok-usage-collector.mjs"), "export const changed = true;\n");
  if (kind === "missing") rmSync(join(source, "scripts", "lib", "shared.mjs"));
  assert.throws(() => checkCollectorInstall(source, destination), /source (must match|graph is incomplete)/);
}));

test("missing or unknown prior provenance cannot authorize changed files", () => fixture(({ source, destination, update }) => {
  update();
  for (const value of ["sha=unknown\n", `sha=${"f".repeat(40)}\n`]) {
    writeFileSync(join(destination, "VERSION"), value);
    assert.throws(() => checkCollectorInstall(source, destination), /baseline|source history/);
  }
}));

test("a previously tracked obsolete collector is identifiable without adopting unknown code", () => fixture(({ source, destination, commit }) => {
  const name = "obsolete-collector.mjs";
  writeFileSync(join(source, "scripts", name), "export {};\n");
  const sha = commit();
  cpSync(join(source, "scripts", name), join(destination, "scripts", name));
  writeFileSync(join(destination, "VERSION"), `sha=${sha}\n`);
  rmSync(join(source, "scripts", name)); commit();
  assert.equal(checkCollectorInstall(source, destination).checked, 4);
}));

test("the main installer preserves an injector outside its rsync allowlist", () => fixture(context => {
  const injector = join(context.source, "scripts", "collector-injector.mjs");
  writeFileSync(injector, "export {};\n");
  const sha = context.commit();
  cpSync(injector, join(context.destination, "scripts", "collector-injector.mjs"));
  writeFileSync(join(context.destination, "VERSION"), `sha=${sha}\n`);
  installerRefuses(context, /Preserving unrecognized installed collector path: collector-injector.mjs/);
}));

test("installed symlinks and unknown directories are rejected without following them", () => fixture(({ root, source, destination }) => {
  const path = join(destination, "scripts", "lib", "shared.mjs");
  rmSync(path); symlinkSync(join(root, "absent"), path);
  assert.throws(() => checkCollectorInstall(source, destination), /Preserving unrecognized installed collector path/);
  rmSync(path); writeFileSync(path, "export {};\n");
  mkdirSync(join(destination, "scripts", "private-helper-directory"));
  assert.throws(() => checkCollectorInstall(source, destination), /Preserving unrecognized installed collector path/);
  const alias = join(root, "alias"); symlinkSync(destination, alias);
  assert.throws(() => checkCollectorInstall(source, alias), /output ancestors must not traverse symlinks/);
}));

test("installer refusal occurs before rsync, dependency installation, receipt or script mutation", () => fixture(({ root, source, destination, update }) => {
  update();
  const helper = join(destination, "scripts", "lib", "purpose-bound.mjs");
  writeFileSync(helper, "export const preserve = true;\n");
  const originalVersion = readFileSync(join(destination, "VERSION"));
  const originalEntry = readFileSync(join(destination, "scripts", "grok-usage-collector.mjs"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const marker = join(root, "mutation-invoked");
  for (const name of ["rsync", "npm"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nprintf invoked >> \"$FIXTURE_MUTATION_MARKER\"\nexit 99\n"); chmodSync(path, 0o700);
  }
  const result = spawnSync("bash", [join(source, "scripts", "install-collectors.sh")], { encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, UM_COLLECTORS_HOME: destination, FIXTURE_MUTATION_MARKER: marker } });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Preserving unrecognized installed collector helper/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(join(destination, "VERSION")), originalVersion);
  assert.deepEqual(readFileSync(join(destination, "scripts", "grok-usage-collector.mjs")), originalEntry);
  assert.equal(readFileSync(helper, "utf8"), "export const preserve = true;\n");
}));

test("a fresh fixture installation copies verified source and records the full preflight SHA", () => fixture(({ root, source, commit }) => {
  writeFileSync(join(source, "scripts", "collector-injector.mjs"), "export {};\n");
  writeFileSync(join(source, "scripts", "lib", "collector-sentry-bridge.mjs"), "export {};\n");
  writeFileSync(join(source, "scripts", "run-subscription-quota-collector.sh"), "#!/bin/sh\nexit 0\n");
  const sha = commit();
  const fresh = join(root, "fresh-installed");
  mkdirSync(join(fresh, "node_modules", "zod"), { recursive: true });
  writeFileSync(join(fresh, "node_modules", "zod", "package.json"), '{"name":"zod"}\n');
  const result = spawnSync("bash", [join(source, "scripts", "install-collectors.sh")], { encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, UM_COLLECTORS_HOME: fresh } });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(fresh, "scripts", "collector-injector.mjs")), false, "main's rsync graph excludes held injector functionality");
  assert.match(readFileSync(join(fresh, "VERSION"), "utf8"), new RegExp(`^sha=${sha}\\n`));
  assert.equal(readFileSync(join(fresh, "scripts", "grok-usage-collector.mjs"), "utf8"), "export const original = true;\n");
  assert.equal(existsSync(join(fresh, "scripts", "check-collector-install.node-test.mjs")), false);
}));

for (const state of ["unchanged", "fresh"]) for (const kind of ["symlink", "dangling-symlink", "directory", "fifo", "hardlink"]) test(`VERSION ${kind} is refused on the ${state} scripts fast path`, () => fixture(context => {
  const { root, destination } = context;
  if (state === "fresh") rmSync(join(destination, "scripts"), { recursive: true });
  const version = join(destination, "VERSION"); rmSync(version);
  const external = join(root, "external-receipt"); writeFileSync(external, "preserve external receipt\n");
  if (kind === "symlink" || kind === "dangling-symlink") symlinkSync(kind === "symlink" ? external : join(root, "absent-receipt"), version);
  if (kind === "directory") mkdirSync(version);
  if (kind === "fifo") execFileSync("mkfifo", [version], { timeout: 5000 });
  if (kind === "hardlink") linkSync(external, version);
  installerRefuses(context, /ELOOP|safe custody/);
  assert.equal(readFileSync(external, "utf8"), "preserve external receipt\n");
}));

for (const kind of ["independent", "symlink", "dangling-symlink", "directory", "fifo", "hardlink"]) test(`package.json ${kind} is preserved before dependency installation`, () => fixture(context => {
  const { root, destination } = context;
  const manifest = join(destination, "package.json");
  const external = join(root, "external-manifest"); writeFileSync(external, '{"name":"independent-owner"}\n');
  if (kind === "independent") cpSync(external, manifest);
  if (kind === "symlink" || kind === "dangling-symlink") symlinkSync(kind === "symlink" ? external : join(root, "absent-manifest"), manifest);
  if (kind === "directory") mkdirSync(manifest);
  if (kind === "fifo") execFileSync("mkfifo", [manifest], { timeout: 5000 });
  if (kind === "hardlink") linkSync(external, manifest);
  installerRefuses(context, /ELOOP|safe custody|Preserving independently managed package/);
  assert.equal(readFileSync(external, "utf8"), '{"name":"independent-owner"}\n');
}));

for (const name of ["package-lock.json", "npm-shrinkwrap.json", ".npmrc"]) test(`existing ${name} blocks dependency writes`, () => fixture(context => {
  writeFileSync(join(context.destination, name), "independent dependency metadata\n");
  installerRefuses(context, /Preserving existing dependency metadata/);
}));

for (const kind of ["directory-link", "lockfile", "partial-zod"]) test(`existing dependency ${kind} is preserved`, () => fixture(context => {
  const modules = join(context.destination, "node_modules");
  if (kind === "directory-link") {
    const target = join(context.root, "external-modules"); mkdirSync(target); symlinkSync(target, modules);
  } else {
    mkdirSync(modules);
    if (kind === "lockfile") writeFileSync(join(modules, ".package-lock.json"), "independent lock\n");
    else mkdirSync(join(modules, "zod"));
  }
  installerRefuses(context, /directory must be owner-owned and regular|requires a clean stage/);
}));

test("source-only dependencies.zod drift is refused before every installer effect", () => fixture(context => {
  writeFileSync(join(context.source, "package.json"), '{"dependencies":{"zod":"file:../unapproved"}}\n');
  installerRefuses(context, /Source package manifest must match its tracked commit/);
}));

test("a source manifest symlink cannot supply dependency authority", () => fixture(context => {
  const manifest = join(context.source, "package.json");
  const external = join(context.root, "source-manifest"); cpSync(manifest, external);
  rmSync(manifest); symlinkSync(external, manifest);
  installerRefuses(context, /ELOOP/);
}));

for (const spec of ["file:../local", "npm:another-package@4.6.6", "latest", "^5.0.0", "4.6.6 || 5.0.0"]) test(`tracked unsupported Zod spec ${spec} is refused`, () => fixture(context => {
  writeFileSync(join(context.source, "package.json"), JSON.stringify({ dependencies: { zod: spec } })); context.commit();
  installerRefuses(context, /Zod must use an explicit stable major-4 npm/);
}));

for (const [label, manifest] of [
  ["invalid JSON", "{"],
  ["null root", "null"],
  ["array root", "[]"],
  ["string root", '"manifest"'],
  ["number root", "42"],
  ["boolean root", "true"],
  ["missing dependencies", "{}"],
  ["null dependencies", '{"dependencies":null}'],
  ["array dependencies", '{"dependencies":[]}'],
  ["string dependencies", '{"dependencies":"zod"}'],
  ["missing zod", '{"dependencies":{}}'],
  ["null zod", '{"dependencies":{"zod":null}}'],
  ["number zod", '{"dependencies":{"zod":4}}'],
  ["array zod", '{"dependencies":{"zod":["^4.6.6"]}}'],
  ["object zod", '{"dependencies":{"zod":{"version":"^4.6.6"}}}'],
  ["prototype-shaped zod", '{"dependencies":{"__proto__":{"zod":"^4.6.6"}}}'],
  ["nonstring dependency", '{"dependencies":{"zod":"^4.6.6","other":false}}'],
]) test(`tracked manifest ${label} is refused before installer writes`, () => fixture(context => {
  writeFileSync(join(context.source, "package.json"), manifest); context.commit();
  installerRefuses(context, /Source package manifest is invalid/);
}));

test("manifest validation permits unrelated fields without installed dependencies", () => fixture(({ source, destination, commit }) => {
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "collector-fixture", private: true, scripts: { ignored: "never executed" }, dependencies: { zod: "~4.6.6", other: "workspace:*" } }));
  commit();
  assert.equal(existsSync(join(source, "node_modules")), false);
  assert.equal(checkCollectorInstall(source, destination).zodSpec, "~4.6.6");
}));

test("existing Zod is preserved without adopting unrelated dependency metadata", () => fixture(({ root, source, destination }) => {
  const external = join(root, "existing-zod"); mkdirSync(external); writeFileSync(join(external, "package.json"), '{"name":"zod"}\n');
  mkdirSync(join(destination, "node_modules")); symlinkSync(external, join(destination, "node_modules", "zod"));
  writeFileSync(join(destination, "package.json"), '{"name":"independently-managed"}\n');
  writeFileSync(join(destination, "package-lock.json"), "preserve independent lock\n");
  const before = snapshot(destination);
  assert.equal(checkCollectorInstall(source, destination).installDependencies, false);
  assert.deepEqual(snapshot(destination), before);
}));

test("fixture roots remain canonical when the temporary parent is a symlink alias", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "collector-install-alias-")));
  try {
    const physical = join(root, "physical"); mkdirSync(physical);
    const alias = join(root, "alias"); symlinkSync(physical, alias);
    fixture(({ root: nested, source, destination }) => {
      assert.equal(nested, realpathSync(nested));
      assert.equal(checkCollectorInstall(source, destination).checked, 3);
    }, { temporaryRoot: alias });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing installation below an aliased ancestor is refused before writes", () => fixture(context => {
  const physical = join(context.root, "physical-destination-parent"); mkdirSync(physical);
  const alias = join(context.root, "aliased-destination-parent"); symlinkSync(physical, alias);
  installerRefuses({ ...context, destination: join(alias, "new-install") }, /Installer output ancestors must not traverse symlinks/);
  assert.equal(existsSync(join(physical, "new-install")), false);
}));

test("the CLI emits verified configuration through an aliased checkout", () => fixture(({ root, source, destination, baseline }) => {
  const alias = join(root, "checkout-alias"); symlinkSync(source, alias);
  const result = spawnSync(process.execPath, [join(alias, "scripts", "check-collector-install.mjs"), alias, destination], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${baseline} ^4.6.6 1\n`);
}));

test("a missing argv path during import returns a controlled failure without rejecting the module", () => fixture(({ root, source }) => {
  const helper = pathToFileURL(join(source, "scripts", "check-collector-install.mjs")).href;
  const missing = join(root, "missing-entrypoint");
  const code = `process.argv[1] = ${JSON.stringify(missing)}; const imported = await import(${JSON.stringify(helper)}); console.log(typeof imported.checkCollectorInstall);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "function\n", "guard failure is handled without an uncaught module evaluation error");
  assert.match(result.stderr, /^\[collector-install-preflight\] ENOENT:/);
  assert.doesNotMatch(result.stderr, /\n\s+at |uncaughtException/);
}));

test("a direct CLI with a missing source checkout fails with only a controlled diagnostic", () => fixture(({ root, source }) => {
  const destination = join(root, "uncreated-install");
  const result = spawnSync(process.execPath, [join(source, "scripts", "check-collector-install.mjs"), join(root, "missing-source"), destination], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "[collector-install-preflight] Cannot verify collector source history\n");
  assert.equal(existsSync(destination), false);
}));

test("an aliased installer still refuses modified source before writes", () => fixture(context => {
  const alias = join(context.root, "checkout-alias"); symlinkSync(context.source, alias);
  writeFileSync(join(context.source, "scripts", "grok-usage-collector.mjs"), "export const independent = true;\n");
  installerRefuses({ ...context, source: alias }, /Collector source must match its tracked commit/);
}));

for (const output of ["", "bad-sha ^4.6.6 1", `${"a".repeat(40)} latest 1`, `${"a".repeat(40)} ^4.6.6 2`, `${"a".repeat(40)} ^4.6.6 1 extra`, `${"a".repeat(40)} ^4.6.6 1\nextra`]) {
  test(`invalid preflight output ${JSON.stringify(output)} cannot authorize installer writes`, () => fixture(context => {
    installerRefuses(context, /invalid collector preflight output/, output);
  }));
}

test("snapshot records link metadata without opening its target", () => fixture(({ root }) => {
  const fifo = join(root, "target-fifo"); execFileSync("mkfifo", [fifo], { timeout: 10000 });
  const alias = join(root, "fifo-link"); symlinkSync(fifo, alias);
  assert.deepEqual(snapshot(alias), { link: fifo });
  rmSync(fifo);
  assert.deepEqual(snapshot(alias), { link: fifo });
}));

test("snapshot enumerates the opened directory when its pathname is replaced", () => fixture(({ root }) => {
  const path = join(root, "snapshot-directory"); mkdirSync(path);
  const replacement = join(root, "replacement-directory"); mkdirSync(replacement);
  writeFileSync(join(replacement, "replacement-only"), "not part of the opened directory\n");
  let handle;
  assert.deepEqual(snapshot(path, directory => {
    handle = directory;
    renameSync(path, join(root, "original-directory"));
    renameSync(replacement, path);
  }), {});
  assert.throws(() => handle.readSync(), { code: "ERR_DIR_CLOSED" });
}));

test("snapshot closes an opened directory when enumeration setup fails", () => fixture(({ root }) => {
  let handle;
  assert.throws(() => snapshot(root, directory => {
    handle = directory;
    throw new Error("synthetic snapshot setup failure");
  }), /synthetic snapshot setup failure/);
  assert.throws(() => handle.readSync(), { code: "ERR_DIR_CLOSED" });
}));

test("private quiescent snapshots detect changed bytes and membership", () => fixture(({ root }) => {
  assert.equal(lstatSync(root).mode & 0o077, 0, "fixture roots are private to their owner");
  const tree = join(root, "quiescent-tree"); mkdirSync(tree);
  const path = join(tree, "entry"); writeFileSync(path, "original\n");
  const original = snapshot(tree);
  assert.deepEqual(snapshot(tree), original);
  writeFileSync(path, "changed\n");
  assert.notDeepEqual(snapshot(tree), original);
  writeFileSync(path, "original\n");
  assert.deepEqual(snapshot(tree), original);
  const added = join(tree, "added"); writeFileSync(added, "extra\n");
  assert.notDeepEqual(snapshot(tree), original);
  rmSync(added);
  assert.deepEqual(snapshot(tree), original);
  rmSync(path);
  assert.notDeepEqual(snapshot(tree), original);
}));

test("a quiescent Unix socket is classified and preserved before installer writes", () => fixture(context => {
  const directory = join(context.destination, "scripts");
  const socket = join(directory, "fixture-socket");
  const code = 'import { createServer } from "node:net"; const server = createServer(); server.listen("fixture-socket", () => process.exit(0));';
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd: directory, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(socket), { special: true });
  installerRefuses(context, /Preserving unrecognized installed collector path: fixture-socket/);
  assert.equal(lstatSync(socket).isSocket(), true);
}));
