// The entry point test suite.
//
// The hub decides whether it is the program node was started with, and it
// decides that by comparing two paths.  Node resolves the URL of the entry
// module to its REAL path, while `process.argv[1]` keeps the path as it
// was typed, so the two differ whenever the hub is launched through a
// symlink.
//
// When the comparison is a plain string equality the hub concludes that it
// was imported rather than run, starts, does nothing at all, and exits 0 in
// silence.  A LaunchAgent pointed at such a path then looks healthy and
// collects nothing.
//
// These tests are about the BEHAVIOUR of the detection, not its shape.
//
// This suite runs under Vitest, like the other suites of this folder.

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

import { isInvokedDirectly } from "../hub.mjs";

describe("isInvokedDirectly", () => {
  let root;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function fixture() {
    root = await mkdtemp(join(tmpdir(), "hub-entry-"));
    const real = join(root, "hub.mjs");
    await writeFile(real, "// fixture\n", "utf8");
    return real;
  }

  it("is true when the two paths are the same file", async () => {
    const real = await fixture();
    assert.equal(isInvokedDirectly(real, pathToFileURL(real).href), true);
  });

  it("is true when the argument path is a symlink to the module", async () => {
    const real = await fixture();
    const link = join(root, "link.mjs");
    await symlink(real, link);
    assert.equal(isInvokedDirectly(link, pathToFileURL(real).href), true);
  });

  it("is false for a different file", async () => {
    const real = await fixture();
    const other = join(root, "other.mjs");
    await writeFile(other, "// other\n", "utf8");
    assert.equal(isInvokedDirectly(other, pathToFileURL(real).href), false);
  });

  it("is false when there is no argument path", () => {
    assert.equal(isInvokedDirectly(undefined, "file:///nowhere/hub.mjs"), false);
    assert.equal(isInvokedDirectly("", "file:///nowhere/hub.mjs"), false);
  });

  it("is false when there is no module url", async () => {
    const real = await fixture();
    assert.equal(isInvokedDirectly(real, undefined), false);
  });

  it("never throws on a path that cannot be resolved", () => {
    const missing = join(tmpdir(), "hub-entry-does-not-exist", "hub.mjs");
    assert.equal(isInvokedDirectly(missing, "file:///nowhere/hub.mjs"), false);
  });

  it("detects a symlinked launch of the hub itself", async () => {
    const real = await fixture();
    const link = join(root, "link.mjs");
    await symlink(real, link);
    //  The plain comparison is what the hub used to do, and it is wrong
    //  exactly here: the two strings differ but the file is one file.
    assert.notEqual(pathToFileURL(link).href, pathToFileURL(real).href);
    assert.equal(isInvokedDirectly(link, pathToFileURL(real).href), true);
  });
});
