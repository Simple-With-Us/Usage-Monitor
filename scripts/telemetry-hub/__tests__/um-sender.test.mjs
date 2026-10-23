// The UM ingest token resolver.
//
// These tests pin the behaviour of createTokenResolver: a rotated or late
// secret is seen by a running hub, a transient lookup failure keeps the last
// good token, and a failed or absent lookup is never memoized as a token.
// They run under Vitest, like the other suites of this folder.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createTokenResolver, readOverlapPolicy, shouldPushLedgerEvent } from "../um-sender.mjs";

const MEMO_MS = 60_000;
//  The memo starts at zero, so the clock must start well past it.
const START = 1_000_000;

function transientError() {
  const error = new Error('fleet secret "USAGE_INGEST_TOKEN" lookup failed');
  error.secretName = "USAGE_INGEST_TOKEN";
  return error;
}

function scripted(steps) {
  let calls = 0;
  const getSecret = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return step;
  };
  return { getSecret, calls: () => calls };
}

describe("createTokenResolver", () => {
  it("prefers the environment token and never asks the secret store", async () => {
    const store = scripted(["from-store"]);
    const resolve = createTokenResolver({
      env: { USAGE_INGEST_TOKEN: "  from-env  " },
      now: () => START,
      getSecret: store.getSecret,
    });
    assert.equal(await resolve(), "from-env");
    assert.equal(store.calls(), 0);
  });

  it("returns the trimmed secret value", async () => {
    const store = scripted(["  tok-1  "]);
    const resolve = createTokenResolver({ env: {}, now: () => START, getSecret: store.getSecret });
    assert.equal(await resolve(), "tok-1");
  });

  it("memoizes an absent secret for one minute, then looks again", async () => {
    const store = scripted([null, "tok-late"]);
    let clock = START;
    const resolve = createTokenResolver({ env: {}, now: () => clock, getSecret: store.getSecret });
    assert.equal(await resolve(), undefined);
    clock = START + MEMO_MS - 1;
    assert.equal(await resolve(), undefined);
    assert.equal(store.calls(), 1);
    clock = START + MEMO_MS + 1;
    assert.equal(await resolve(), "tok-late");
    assert.equal(store.calls(), 2);
  });

  it("keeps the last good token across a transient lookup failure", async () => {
    const store = scripted(["tok-1", transientError(), "tok-2"]);
    let clock = START;
    const resolve = createTokenResolver({ env: {}, now: () => clock, getSecret: store.getSecret });
    assert.equal(await resolve(), "tok-1");
    clock = START + MEMO_MS + 1;
    assert.equal(await resolve(), "tok-1");
    //  The failed lookup was not memoized, so the very next pass asks again.
    clock = START + MEMO_MS + 2;
    assert.equal(await resolve(), "tok-2");
    assert.equal(store.calls(), 3);
  });

  it("throws a transient lookup failure when no good token exists yet", async () => {
    const failure = transientError();
    const store = scripted([failure, "tok-1"]);
    let clock = START;
    const resolve = createTokenResolver({ env: {}, now: () => clock, getSecret: store.getSecret });
    await assert.rejects(resolve(), (error) => error === failure);
    clock = START + 1;
    assert.equal(await resolve(), "tok-1");
  });
});

describe("ledger overlap defaults", () => {
  const localCollectorPlatforms = ["opencode", "fx"];

  it("skips OpenCode and FX by default", () => {
    const policy = readOverlapPolicy({});
    for (const platform of localCollectorPlatforms) {
      assert.equal(shouldPushLedgerEvent({ platform, provider: "openai" }, policy), false);
    }
  });

  it("allows explicit overlap and keeps the allowlist from bypassing the overlap block", () => {
    const overlapAllowed = readOverlapPolicy({ TELEMETRY_HUB_ALLOW_OVERLAP: "1" });
    const allowlistedOnly = readOverlapPolicy({ TELEMETRY_HUB_PLATFORM_ALLOWLIST: "opencode,fx" });
    for (const platform of localCollectorPlatforms) {
      assert.equal(shouldPushLedgerEvent({ platform, provider: "openai" }, overlapAllowed), true);
      assert.equal(shouldPushLedgerEvent({ platform, provider: "openai" }, allowlistedOnly), false);
    }
  });
});
