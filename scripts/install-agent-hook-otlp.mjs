#!/usr/bin/env node
// Installs the PINNED, worktree-independent copy of agent-hook-otlp.mjs that
// every hooks.json (agy, Cursor, Copilot CLI) actually invokes.
//
// Why: the human integration tree (~/Code/Usage-Monitor) is reset by a
// daemon and can be checked out on any branch at any time -- see
// /Users/jay/.claude/CLAUDE.md "Where to work".  Wiring hooks directly at a
// path inside that tree means every wired hook silently breaks
// (MODULE_NOT_FOUND) whenever that tree lags a fix to this script, or
// briefly reintroduces an already-fixed bug whenever it is checked out
// between two commits that touched this file.  This script decouples the
// installed copy from whatever the tree happens to have checked out, by
// reading the file's content straight out of `origin/main` via git, not off
// disk.
//
// Usage:
//   node scripts/install-agent-hook-otlp.mjs [--repo <path>] [--dest <path>]
//     --repo   a local clone of this repo with `origin` configured
//              (default: ~/Code/Usage-Monitor)
//     --dest   where to install the pinned copy
//              (default: ~/.local/share/agent-hook-otlp/agent-hook-otlp.mjs)
//
// Idempotent: safe to run any time (e.g. after every merge that touches
// scripts/agent-hook-otlp.mjs); it always overwrites the destination with
// origin/main's current content and never touches hooks.json wiring itself.
// Prints only paths and byte counts -- there is nothing secret in this file.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_PATH = "scripts/agent-hook-otlp.mjs";

function parseArgs(argv) {
  const args = { repo: join(homedir(), "Code", "Usage-Monitor"), dest: defaultDestPath() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") args.repo = argv[++i];
    else if (argv[i] === "--dest") args.dest = argv[++i];
  }
  return args;
}

export function defaultDestPath() {
  return join(homedir(), ".local", "share", "agent-hook-otlp", "agent-hook-otlp.mjs");
}

export function installFromOriginMain({ repo, dest }, deps = {}) {
  const exec = deps.execFileSync ?? execFileSync;
  const write = deps.writeFileSync ?? writeFileSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const chmod = deps.chmodSync ?? chmodSync;
  const read = deps.readFileSync ?? readFileSync;

  exec("git", ["-C", repo, "fetch", "-q", "origin", "main"], { stdio: "ignore" });
  const content = exec("git", ["-C", repo, "show", `origin/main:${SOURCE_PATH}`], { encoding: "utf8" });
  if (!content || !content.includes("agent-hook-otlp")) {
    throw new Error(`unexpected content reading origin/main:${SOURCE_PATH} from ${repo}`);
  }

  mkdir(dirname(dest), { recursive: true });
  write(dest, content, { mode: 0o755 });
  chmod(dest, 0o755); // re-tighten in case dest pre-existed with a different mode

  const installedSize = read(dest, "utf8").length;
  return { dest, size: installedSize };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dest, size } = installFromOriginMain(args);
  console.log(`installed ${dest} (${size} bytes) from origin/main:${SOURCE_PATH} in ${args.repo}`);
}

/**
 * True when this module is the process entrypoint, not merely `import`ed.
 * Same symlink-safe pattern as agent-hook-otlp.mjs's own `isEntrypoint()`:
 * a bare `import.meta.url === \`file://${process.argv[1]}\`` comparison is
 * false whenever this script is invoked through a symlink (Node resolves
 * `import.meta.url` to the real path but leaves `process.argv[1]` as
 * given), which would silently skip `main()` -- this script would exit 0
 * having installed nothing, with no error.
 */
export function isEntrypoint(argv = process.argv, metaUrl = import.meta.url, realpath = realpathSync) {
  if (!argv[1]) return false;
  try {
    return metaUrl === pathToFileURL(realpath(argv[1])).href;
  } catch {
    return metaUrl === pathToFileURL(argv[1]).href;
  }
}

if (isEntrypoint()) {
  main();
}
