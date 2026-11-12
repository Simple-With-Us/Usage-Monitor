#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expected = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const imageVersions = [...dockerfile.matchAll(/^FROM node:([^\s-]+)-bookworm-slim AS /gm)].map(
  (match) => match[1]
);

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
assert.equal(
  packageJson.engines?.node,
  ">=24.14.0 <25",
  "package.json must keep the supported Node 24 engine range"
);

// The supported range lives in package.json's engines floor; the pinned
// version lives in .node-version.  Both are read here rather than restated
// as a literal "24", so a major bump moves the two together instead of
// leaving a duplicated constant behind to drift.
const enginesFloor = packageJson.engines.node
  .match(/>=(\d+)\.(\d+)\.(\d+)/)
  .slice(1)
  .map((part) => Number.parseInt(part, 10));
const expectedMajor = Number.parseInt(expected.split(".")[0], 10);

assert.match(expected, /^\d+\.\d+\.\d+$/, ".node-version must pin an exact Node version");
assert.equal(
  expectedMajor,
  enginesFloor[0],
  ".node-version major must match the package.json engines floor major"
);
assert.equal(imageVersions.length, 2, "Dockerfile must declare build and runtime Node images");
assert.deepEqual(
  imageVersions,
  [expected, expected],
  `Dockerfile Node images must match .node-version (${expected})`
);

// The declared versions above say what the project supports.  This asserts the
// interpreter that is actually running, which nothing else checked.  A host
// whose default `node` is off the supported line will otherwise run an entire
// gate on an unsupported runtime, and its failures are runtime artifacts
// rather than product defects.
//
// Two concrete ways that misleads, both observed on a fleet server whose
// default `node` was v22 while this repo pins Node 24:
//   - `utimesSync` plus `statSync().mtimeMs` loses sub-millisecond precision,
//     so an exact-millisecond timestamp assertion fails intermittently.
//   - a native module installed under the other runtime carries the wrong ABI
//     and fails to load, which fails every database-backed test at once.
// The second one is the worse of the two: a stale `node_modules` built under
// v22 makes Node 24 report hundreds of failures that no code change caused.

// The running interpreter must satisfy the engines floor, not merely share
// the expected major: v24.0.0 is on the right major line but below the
// supported floor, and it fails here instead of producing runtime artifacts.
const running = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
const atOrAboveFloor =
  running[0] > enginesFloor[0] ||
  (running[0] === enginesFloor[0] &&
    (running[1] > enginesFloor[1] ||
      (running[1] === enginesFloor[1] && running[2] >= enginesFloor[2])));

assert.ok(
  running[0] === expectedMajor && atOrAboveFloor,
  `Node runtime mismatch: this repo requires Node ${expected} (${packageJson.engines.node}), but the running interpreter is v${process.versions.node}. ` +
    `Install the pinned runtime before running tests or verify.`
);

console.log(`Node runtime parity checks passed (${expected}, running v${process.versions.node})`);
