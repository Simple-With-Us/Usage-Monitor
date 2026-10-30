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

console.log(`Node runtime parity checks passed (${expected})`);
