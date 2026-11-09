#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expected = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const imageVersions = [...dockerfile.matchAll(/^FROM node:([^\s-]+)-bookworm-slim AS /gm)].map(
  (match) => match[1]
);

assert.match(expected, /^24\.\d+\.\d+$/, ".node-version must stay on the supported Node 24 line");
assert.equal(imageVersions.length, 2, "Dockerfile must declare build and runtime Node images");
assert.deepEqual(
  imageVersions,
  [expected, expected],
  `Dockerfile Node images must match .node-version (${expected})`
);

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
assert.equal(
  packageJson.engines?.node,
  ">=24.14.0 <25",
  "package.json must keep the supported Node 24 engine range"
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

const runningMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
assert.equal(
  runningMajor,
  24,
  `Node runtime mismatch: this repo requires Node ${expected}, but the running interpreter is v${process.versions.node}. ` +
    `Install the pinned runtime before running tests or verify.`
);

console.log(`Node runtime parity checks passed (${expected}, running v${process.versions.node})`);
