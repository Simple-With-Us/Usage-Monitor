import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rcSh = readFileSync(join(ROOT, "scripts/ios-fleet/tf-ready-rc.sh"), "utf8");
const shipSh = readFileSync(join(ROOT, "scripts/ios-fleet/ship-testflight.sh"), "utf8");

function branchAfter(rc) {
  const body = rcSh.slice(rcSh.indexOf("handle_ensure_tf_ready_rc"));
  const re = new RegExp(String.raw`\n    ${rc}\)[\s\S]*?(?=\n    (?:\d+|\*)\)|\nesac)`);
  const m = body.match(re);
  assert.ok(m, `missing case for rc=${rc} in handle_ensure_tf_ready_rc`);
  return m[0];
}

test("ensure-tf-ready rc codes map to distinct handler branches", () => {
  for (const rc of [0, 2, 3, 4, 5, 6]) {
    assert.ok(branchAfter(rc).length > 10, `rc=${rc} branch is empty`);
  }
  // Strip each branch's own `rc)` header before comparing: with the
  // header included the slices are trivially distinct even when the
  // branch bodies are identical.
  const bodies = [0, 2, 3, 4, 5, 6].map((rc) => branchAfter(rc).replace(/^\n\s*\d+\)/, ""));
  const uniq = new Set(bodies);
  assert.equal(uniq.size, bodies.length, "each rc branch must be distinct");
});

test("rc=5 and rc=6 do not use the export-compliance mislabel", () => {
  const rc5 = branchAfter(5);
  const rc6 = branchAfter(6);
  assert.doesNotMatch(rc5, /export compliance/);
  assert.doesNotMatch(rc6, /export compliance/);
  assert.match(rc5, /no internal TestFlight testers with access to all builds/);
  assert.match(rc5, /::warning title=TestFlight has no reachable internal tester::/);
  assert.match(rc6, /installability is unverified/);
  assert.match(rc6, /::warning title=TestFlight installability unverified::/);
});

test("rc=2 alone carries the export-compliance warning", () => {
  const rc2 = branchAfter(2);
  assert.match(rc2, /build may be stuck on export compliance/);
  const rc4 = branchAfter(4);
  assert.match(rc4, /export compliance NOT declared/);
  const rc3 = branchAfter(3);
  assert.match(rc3, /IN_BETA_TESTING/);
});

test("ship-testflight ensure_tf_ready delegates to handle_ensure_tf_ready_rc", () => {
  assert.match(shipSh, /source "\$\{FLEET_DIR\}\/tf-ready-rc\.sh"/);
  const fnStart = shipSh.indexOf("ensure_tf_ready()");
  const fnEnd = shipSh.indexOf("\nacquire_archive_lock", fnStart);
  const fn = shipSh.slice(fnStart, fnEnd);
  assert.match(fn, /handle_ensure_tf_ready_rc "\$rc"/);
  assert.doesNotMatch(fn, /if \[\[ \$rc -eq 0 \]\]/);
});

test("ios-ship.yml rechecks readiness after standing-tester sync and summarizes the second result", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/ios-ship.yml"), "utf8");
  assert.match(yml, /name: Re-check TestFlight readiness after tester sync \(usage\)/);
  assert.match(yml, /ios-recheck-tf-ready\.sh" usage/);
  assert.match(yml, /steps\.ship_usage\.outputs\.uploaded == '1'/);
  assert.match(yml, /steps\.ship_usage_local\.outputs\.uploaded == '1'/);
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
  assert.match(yml, /name: Re-check TestFlight readiness after tester sync \(usage-local\)/);
  assert.match(yml, /ios-recheck-tf-ready\.sh" usage-local/);
  assert.match(yml, /recheck_usage\.outputs\.tf_ready_summary/);
  assert.match(yml, /recheck_usage_local\.outputs\.tf_ready_summary/);
  const usageSync = yml.indexOf("name: Sync standing TestFlight testers (usage)");
  const usageRecheck = yml.indexOf("name: Re-check TestFlight readiness after tester sync (usage)");
  assert.ok(usageRecheck > usageSync, "usage recheck follows the sync step");
});
