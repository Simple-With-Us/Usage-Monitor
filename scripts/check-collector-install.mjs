import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORIES = new Set(["lib", "telemetry-hub"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const INSTALL_PACKAGE = '{"name":"usage-monitor-collectors","private":true,"type":"module"}\n';

function selected(name) {
  const parts = name.split("/");
  return parts.length === 2 ? DIRECTORIES.has(parts[0]) && parts[1].endsWith(".mjs") : parts.length === 1 && (
    name.endsWith("-collector.mjs") || ["run-subscription-quota-collector.sh", "antigravity-statusline-telemetry.mjs"].includes(name)
  );
}

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function inspect(path, { text = false, maxBytes = text ? 4096 : MAX_FILE_BYTES, singleLink = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (singleLink && before.nlink !== 1) || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) throw new Error("Install input must be a bounded owner-owned regular file with safe custody");
    const sha256 = createHash("sha256");
    const blob = createHash("sha1").update(`blob ${before.size}\0`);
    const buffer = Buffer.alloc(64 * 1024);
    const chunks = [];
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new Error("Install input changed while reading");
      const bytes = buffer.subarray(0, count);
      sha256.update(bytes); blob.update(bytes);
      if (text) chunks.push(Buffer.from(bytes));
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== before.nlink || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Install input changed while reading");
    return { sha256: sha256.digest("hex"), blob: blob.digest("hex"), mode: before.mode & 0o100 ? "100755" : "100644", text: text ? Buffer.concat(chunks).toString("utf8") : undefined };
  } finally { closeSync(fd); }
}

function git(source, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !key.startsWith("LD_") && !key.startsWith("DYLD_")));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  try {
    return execFileSync("/usr/bin/git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", source, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error("Cannot verify collector source history"); }
}

function tracked(source, sha) {
  const entries = new Map();
  for (const row of git(source, ["ls-tree", "-rz", sha, "--", "scripts"]).split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755) blob ([a-f0-9]{40})\tscripts\/(.+)$/.exec(row);
    if (parsed && selected(parsed[3])) entries.set(parsed[3], { mode: parsed[1], blob: parsed[2] });
  }
  return entries;
}

function directory(path) {
  const info = stat(path);
  if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("Collector installation directory must be owner-owned and regular");
}

function validatePackageManifest(value) {
  // Bootstrap validation cannot depend on the package it is about to install.
  const record = input => input !== null && typeof input === "object" && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype;
  if (!record(value) || !Object.hasOwn(value, "dependencies") || !record(value.dependencies)) throw new Error("Source package manifest shape is invalid");
  const dependencies = value.dependencies;
  if (!Object.hasOwn(dependencies, "zod") || Object.values(dependencies).some(spec => typeof spec !== "string")) throw new Error("Source package manifest dependencies must be strings including zod");
  return { dependencies };
}

function sourceZod(source, head) {
  const manifest = inspect(join(source, "package.json"), { text: true, maxBytes: 64 * 1024 });
  const row = git(source, ["ls-tree", "-z", head, "--", "package.json"]);
  const expected = /^(100644|100755) blob ([a-f0-9]{40})\tpackage\.json\0$/.exec(row);
  if (!expected || manifest.mode !== expected[1] || manifest.blob !== expected[2]) throw new Error("Source package manifest must match its tracked commit");
  let parsed;
  try { parsed = validatePackageManifest(JSON.parse(manifest.text)); }
  catch { throw new Error("Source package manifest is invalid"); }
  const spec = parsed.dependencies.zod;
  if (typeof spec !== "string" || spec.length > 32 || !/^[~^]?4\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(spec)) throw new Error("Zod must use an explicit stable major-4 npm version or caret/tilde range");
  return spec;
}

function outputCustody(destination) {
  let ancestor = destination;
  while (!stat(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error("Installer output ancestors must not traverse symlinks");
  if (stat(destination)) directory(destination);
  const versionPath = join(destination, "VERSION");
  const version = stat(versionPath) ? inspect(versionPath, { text: true, singleLink: true }).text : null;
  const zodPackage = join(destination, "node_modules", "zod", "package.json");
  let present = false;
  try { present = statSync(zodPackage).isFile(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Existing dependencies are preserved when no dependency output will be written.
  if (present) return { version, installDependencies: false };
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", ".npmrc"]) {
    if (stat(join(destination, name))) throw new Error(`Preserving existing dependency metadata: ${name}`);
  }
  const packagePath = join(destination, "package.json");
  if (stat(packagePath) && inspect(packagePath, { text: true, maxBytes: 64 * 1024, singleLink: true }).text !== INSTALL_PACKAGE) throw new Error("Preserving independently managed package.json");
  const modules = join(destination, "node_modules");
  if (stat(modules)) {
    directory(modules);
    if (readdirSync(modules).length !== 0) throw new Error("Preserving existing dependency directory; dependency installation requires a clean stage");
  }
  return { version, installDependencies: true };
}

export function checkCollectorInstall(source, destination) {
  source = resolve(source); destination = resolve(destination);
  const head = git(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Cannot verify collector source commit");
  const zodSpec = sourceZod(source, head);
  const custody = outputCustody(destination);
  const expected = tracked(source, head);
  const incoming = new Map();
  for (const dir of ["", ...DIRECTORIES]) {
    const path = join(source, "scripts", dir);
    directory(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (!selected(name)) continue;
      const value = inspect(join(path, entry.name));
      const original = expected.get(name);
      if (!original || original.blob !== value.blob || original.mode !== value.mode) throw new Error(`Collector source must match its tracked commit: ${name}`);
      incoming.set(name, value);
    }
  }
  if (incoming.size !== expected.size) throw new Error("Collector source graph is incomplete");
  const scripts = join(destination, "scripts");
  if (!stat(scripts)) return { sourceSha: head, zodSpec, installDependencies: custody.installDependencies, checked: 0 };
  directory(destination); directory(scripts);
  let previous;
  function baseline() {
    if (previous) return previous;
    const version = custody.version;
    if (version === null) throw new Error("Installed collector baseline is not verifiable");
    const matches = [...version.matchAll(/^sha=([a-f0-9]{7,40})$/gm)];
    if (matches.length !== 1) throw new Error("Installed collector baseline is not verifiable");
    const commit = git(source, ["rev-parse", "--verify", "--end-of-options", `${matches[0][1]}^{commit}`]).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Installed collector baseline is not verifiable");
    previous = tracked(source, commit);
    return previous;
  }
  let checked = 0;
  function walk(dir = "") {
    for (const entry of readdirSync(join(scripts, dir), { withFileTypes: true })) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink() && !dir && DIRECTORIES.has(name)) {
        directory(join(scripts, name)); walk(name); continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !selected(name)) throw new Error(`Preserving unrecognized installed collector path: ${name}`);
      const desired = incoming.get(name);
      if (!desired && !baseline().has(name)) throw new Error(`Preserving unrecognized installed collector helper: ${name}`);
      const current = inspect(join(scripts, name));
      checked += 1;
      if (desired?.sha256 === current.sha256 && desired.mode === current.mode) continue;
      const old = baseline().get(name);
      if (!old || old.blob !== current.blob || old.mode !== current.mode) throw new Error(`Preserving independently modified installed collector: ${name}`);
    }
  }
  walk();
  return { sourceSha: head, zodSpec, installDependencies: custody.installDependencies, checked };
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
} catch {
  isMain = false;
}
if (isMain) {
  try {
    if (process.argv.length !== 4) throw new Error("Expected source checkout and installed directory");
    const result = checkCollectorInstall(process.argv[2], process.argv[3]);
    console.log(`${result.sourceSha} ${result.zodSpec} ${result.installDependencies ? "1" : "0"}`);
  } catch (error) {
    console.error(`[collector-install-preflight] ${error.message}`);
    process.exitCode = 1;
  }
}
