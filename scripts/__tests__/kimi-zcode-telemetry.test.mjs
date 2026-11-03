import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";

import {
  acknowledgeKimiEvents,
  collectKimiEvents,
  finishKimiPass,
  kimiWireIdentity,
  readPendingSessions,
  writeKimiPendingMarker,
} from "../kimi-usage-collector.mjs";
import {
  KIMI_PRODUCER_ID,
  parseKimiSessionIndexJsonl,
  parseKimiUsageJsonl,
  parseZcodeModelUsageRows,
  ZCODE_PRODUCER_ID,
  zcodeProviderName,
  zcodeTokenBreakdown,
} from "../lib/kimi-zcode-telemetry.mjs";
import {
  collectZcodeEvents,
  defaultZcodeDbPath,
  readZcodeModelUsageRows,
} from "../zcode-usage-collector.mjs";
import {
  canAdvanceCollectorCheckpoint,
  collectorStatePath,
  configureCollectorSentryToken,
} from "../lib/run-session-token-collector.mjs";
import { collectorSentryEvents } from "../lib/collector-sentry-bridge.mjs";

let tempRoot;

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function kimiStateRoot() {
  return join(tempRoot, "collector-state");
}

function kimiTurn(overrides = {}) {
  return {
    type: "usage.record",
    model: "kimi-k2",
    usage: {
      inputOther: 10,
      output: 5,
      inputCacheRead: 20,
      inputCacheCreation: 3,
    },
    usageScope: "turn",
    time: 1_779_256_800_302,
    ...overrides,
  };
}

describe("Kimi exact usage telemetry", () => {
  it("maps one durable turn record to exact token components", () => {
    const events = parseKimiUsageJsonl(JSON.stringify(kimiTurn()), {
      sessionKey: "workspace/session/agents/main/wire.jsonl",
      sessionId: "session",
      agentId: "main",
      project: "Usage-Monitor",
    });
    expect(events.map((event) => [event.label, event.quantity])).toEqual([
      ["token:input", 10],
      ["token:output", 5],
      ["token:cacheRead", 20],
      ["token:cacheCreation", 3],
    ]);
    expect(events.every((event) => event.provider === "moonshot")).toBe(true);
    expect(events.every((event) => event.service === "kimi-code")).toBe(true);
    expect(events.every((event) => event.confidence === "actual")).toBe(true);
    expect(events.every((event) => event.project === "Usage-Monitor")).toBe(true);
    expect(events[0].metadata).toMatchObject({
      harness: "kimi-code",
      usageScope: "turn",
      tokenBreakdownComplete: true,
      "session.id": "session",
      "agent.id": "main",
    });
  });

  it("ignores cumulative session usage, malformed rows, and zero-token turns", () => {
    const text = [
      JSON.stringify(kimiTurn({ usageScope: "session" })),
      "{not json",
      JSON.stringify(kimiTurn({ usage: {} })),
      JSON.stringify({ type: "other", time: 1_779_256_800_302 }),
    ].join("\n");
    expect(parseKimiUsageJsonl(text)).toEqual([]);
  });

  it("keeps known buckets when cache-read usage is absent and marks the split incomplete", () => {
    const row = kimiTurn({
      usage: { inputOther: 10, output: 5, inputCacheCreation: 3 },
    });
    const events = parseKimiUsageJsonl(JSON.stringify(row), { sessionKey: "s" });
    expect(events.map((event) => event.label)).toEqual([
      "token:input",
      "token:output",
      "token:cacheCreation",
    ]);
    expect(events.every((event) => event.metadata.tokenBreakdownComplete === false)).toBe(true);
    expect(events.every((event) => event.confidence === "estimated")).toBe(true);
  });

  it("marks the split incomplete when cache-creation usage is absent", () => {
    const row = kimiTurn({
      usage: { inputOther: 10, output: 5, inputCacheRead: 20 },
    });
    const events = parseKimiUsageJsonl(JSON.stringify(row), { sessionKey: "s" });
    expect(events.map((event) => event.label)).toEqual([
      "token:input",
      "token:output",
      "token:cacheRead",
    ]);
    expect(events.every((event) => event.metadata.tokenBreakdownComplete === false)).toBe(true);
    expect(events.every((event) => event.confidence === "estimated")).toBe(true);
  });

  it("keeps event ids stable when unrelated lines are inserted before a record", () => {
    const record = JSON.stringify(kimiTurn());
    const before = parseKimiUsageJsonl(record, { sessionKey: "s" });
    const after = parseKimiUsageJsonl(`${JSON.stringify({ type: "other" })}\n${record}`, {
      sessionKey: "s",
    });
    expect(after.map((event) => event.eventId)).toEqual(before.map((event) => event.eventId));
  });

  it("reads the session index without exposing full work directories in events", () => {
    const index = parseKimiSessionIndexJsonl(
      [
        JSON.stringify({ sessionId: "s1", sessionDir: "/opaque/s1", workDir: "/Code/App-One" }),
        "{partial",
        JSON.stringify({ sessionId: "s2", workDir: "/Code/App-Two" }),
      ].join("\n"),
    );
    expect(index).toEqual(new Map([["s1", "/Code/App-One"], ["s2", "/Code/App-Two"]]));
  });

  it("collects nested wire files and tags a known BotFleet workspace", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Users/jay/.botfleet/workspaces/demo" })}\n`,
    );
    const events = await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.metadata["agent.launcher"] === "botfleet")).toBe(true);
    expect(events.every((event) => event.project === "demo")).toBe(true);
    expect(kimiWireIdentity(join(home, "sessions"), wire)).toMatchObject({
      sessionId: "session-a",
      agentId: "main",
    });
  });

  it("advances the global checkpoint and replays deferred rows after the session index recovers", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    const incomplete = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: incomplete })).toEqual([]);
    expect(incomplete.complete).toBe(true);
    expect(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: incomplete.complete })).toBe(true);

    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );
    const recovered = { complete: true };
    const events = await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(Date.now() + 60_000),
      scanStatus: recovered,
    });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.project === "Usage-Monitor")).toBe(true);
    expect(recovered.complete).toBe(true);
    await acknowledgeKimiEvents(kimiStateRoot(), recovered);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toEqual([]);
  });

  it("adds an earlier marker when an older overlapping scan follows a newer marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const now = Date.now();
    await writeFile(wire, `${JSON.stringify(kimiTurn({ time: (now - 10 * 60 * 60_000) / 1000 }))}\n`);
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(now - 60 * 60_000),
      }),
    ).toEqual([]);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );

    const olderReplay = await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(now - 24 * 60 * 60_000),
    });
    expect(olderReplay).toHaveLength(4);
    expect(olderReplay.every((event) => event.project === "Usage-Monitor")).toBe(true);
  });

  it("defers rows whose session is absent from the readable index and restores attribution on replay", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "another-session", workDir: "/Code/Other" })}\n`,
    );

    const incomplete = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: incomplete })).toEqual([]);
    expect(incomplete.complete).toBe(true);

    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Users/jay/.botfleet/workspaces/demo" })}\n`,
    );
    const recovered = { complete: true };
    const events = await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: recovered });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.project === "demo")).toBe(true);
    expect(events.every((event) => event.metadata["agent.launcher"] === "botfleet")).toBe(true);
    expect(recovered.complete).toBe(true);
  });

  it("keeps recovered pending markers intact during a dry run", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );

    const dryRunStatus = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus: dryRunStatus,
        dryRun: true,
      }),
    ).toHaveLength(4);
    await acknowledgeKimiEvents(kimiStateRoot(), dryRunStatus, { dryRun: true });

    const realStatus = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus: realStatus,
      }),
    ).toHaveLength(4);
  });

  it("writes the checkpoint before deleting resolved markers and preserves them on checkpoint failure", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );
    const recovered = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus: recovered,
      }),
    ).toHaveLength(4);

    await expect(
      finishKimiPass({
        args: { dryRun: false, explicitSince: false },
        passStartedAt: new Date(),
        scanStatus: recovered,
        stateRoot: kimiStateRoot(),
        recordSuccess: async () => {
          throw new Error("checkpoint write failed");
        },
      }),
    ).rejects.toThrow("checkpoint write failed");
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(4);

    const order = [];
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: recovered,
      stateRoot: kimiStateRoot(),
      recordSuccess: async () => {
        order.push("checkpoint");
        expect(
          await collectKimiEvents({
            home,
            stateRoot: kimiStateRoot(),
            since: new Date(Date.now() + 60_000),
          }),
        ).toHaveLength(4);
      },
    });
    order.push("finish");
    expect(order).toEqual(["checkpoint", "finish"]);
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toEqual([]);
  });

  it("acknowledges only pending markers observed for resolved files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wireA = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wireA, ".."), { recursive: true });
    await writeFile(wireA, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );

    const wireB = join(home, "sessions", "workspace", "session-b", "agents", "main", "wire.jsonl");
    await mkdir(join(wireB, ".."), { recursive: true });
    await writeFile(wireB, `${JSON.stringify(kimiTurn({ time: 1_779_256_801_302 }))}\n`);
    const firstResolved = { complete: true };
    await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(0),
      scanStatus: firstResolved,
    });
    await acknowledgeKimiEvents(kimiStateRoot(), firstResolved);

    await writeFile(
      join(home, "session_index.jsonl"),
      [
        JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" }),
        JSON.stringify({ sessionId: "session-b", workDir: "/Code/Other" }),
      ].join("\n") + "\n",
    );
    const replay = await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(Date.now() + 60_000),
    });
    expect(replay).toHaveLength(4);
    expect(replay.every((event) => event.metadata["session.id"] === "session-b")).toBe(true);
  });

  it("preserves a marker generation created after the resolving scan observed its marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );

    const resolvingScan = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus: resolvingScan,
      }),
    ).toHaveLength(4);
    await writeKimiPendingMarker(
      kimiStateRoot(),
      "workspace/session-a/agents/main/wire.jsonl",
      new Date(0).toISOString(),
    );
    await acknowledgeKimiEvents(kimiStateRoot(), resolvingScan);

    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(4);
  });

  it("preserves deferred rows when an unmapped scan overlaps a resolver", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    const index = join(home, "session_index.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const first = kimiTurn();
    const second = kimiTurn({ time: first.time + 1000 });
    await writeFile(wire, `${JSON.stringify(first)}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(index, `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`);

    const resolvingScan = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: resolvingScan })).toHaveLength(4);
    await writeFile(wire, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    await rm(index);
    const deferredScan = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: deferredScan })).toEqual([]);
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: deferredScan,
      stateRoot: kimiStateRoot(),
      recordSuccess: async () => {},
    });
    await acknowledgeKimiEvents(kimiStateRoot(), resolvingScan);
    await writeFile(index, `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`);

    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(8);
  });

  it("does not force-read a pending source until its session mapping exists", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await rm(wire);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "another-session", workDir: "/Code/Other" })}\n`,
    );

    const scanStatus = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus,
      }),
    ).toEqual([]);
    expect(scanStatus.complete).toBe(true);

    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(4);
  });

  it("keeps a deleted pending marker without freezing the scan and replays if the file returns", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/Usage-Monitor" })}\n`,
    );
    await rm(wire);

    const missing = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
        scanStatus: missing,
      }),
    ).toEqual([]);
    expect(missing.complete).toBe(true);

    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(4);
  });

  it("retains markers from overlapping scans of distinct files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wireA = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    const wireB = join(home, "sessions", "workspace", "session-b", "agents", "main", "wire.jsonl");
    await mkdir(join(wireA, ".."), { recursive: true });
    await mkdir(join(wireB, ".."), { recursive: true });
    await writeFile(wireA, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(wireB, `${JSON.stringify(kimiTurn({ time: 1_779_256_801_302 }))}\n`);
    await utimes(wireA, new Date("2026-04-20T00:00:00Z"), new Date("2026-04-20T00:00:00Z"));
    await utimes(wireB, new Date("2026-05-02T00:00:00Z"), new Date("2026-05-02T00:00:00Z"));

    const first = { complete: true };
    const second = { complete: true };
    await Promise.all([
      collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date("2026-04-15T00:00:00Z"),
        scanStatus: first,
      }),
      collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date("2026-05-01T00:00:00Z"),
        scanStatus: second,
      }),
    ]);

    await writeFile(
      join(home, "session_index.jsonl"),
      [
        JSON.stringify({ sessionId: "session-a", workDir: "/Code/App-A" }),
        JSON.stringify({ sessionId: "session-b", workDir: "/Code/App-B" }),
      ].join("\n") + "\n",
    );
    const replay = await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(Date.now() + 60_000),
    });
    expect(replay).toHaveLength(8);
    expect(new Set(replay.map((event) => event.project))).toEqual(new Set(["App-A", "App-B"]));
  });

  it("fails closed when the durable pending state is corrupt", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    const path = `${collectorStatePath(KIMI_PRODUCER_ID, kimiStateRoot(), "pending")}.d/corrupt.json`;
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{corrupt state\n");

    await expect(
      collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) }),
    ).rejects.toThrow();
  });

  it("fails the pending snapshot if a listed marker disappears before it can be read", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    await writeKimiPendingMarker(kimiStateRoot(), "workspace/session-a/agents/main/wire.jsonl", new Date(0).toISOString());
    await expect(readPendingSessions(kimiStateRoot(), {
      readMarker: async (path) => {
        await rm(path);
        const error = new Error("marker disappeared");
        error.code = "ENOENT";
        throw error;
      },
    })).rejects.toThrow("marker disappeared");
  });

  it("defers a mapped session until its working directory yields a project", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    const index = join(home, "session_index.jsonl");
    await writeFile(index, `${JSON.stringify({ sessionId: "session-a", workDir: "/" })}\n`);
    const unresolved = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0), scanStatus: unresolved })).toEqual([]);
    await acknowledgeKimiEvents(kimiStateRoot(), unresolved);
    await writeFile(index, `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const events = await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.project === "App")).toBe(true);
  });

  it("retains a pending marker until an incomplete trailing row is complete", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const first = JSON.stringify(kimiTurn());
    const second = JSON.stringify(kimiTurn({ time: kimiTurn().time + 1000 }));
    await writeFile(wire, `${first}\n${second.slice(0, -2)}`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const partial = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000), scanStatus: partial })).toHaveLength(4);
    await finishKimiPass({ args: { dryRun: false, explicitSince: false }, passStartedAt: new Date(), scanStatus: partial, stateRoot: kimiStateRoot(), recordSuccess: async () => {} });
    await writeFile(wire, `${first}\n${second}\n`);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(8);
  });

  it("retains an old partial row that completes before its session is mapped", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const row = JSON.stringify(kimiTurn());
    await writeFile(wire, row.slice(0, -2));
    const deferred = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date("2026-10-01T00:00:00Z"), scanStatus: deferred })).toEqual([]);
    await finishKimiPass({ args: { dryRun: false, explicitSince: false }, passStartedAt: new Date(), scanStatus: deferred, stateRoot: kimiStateRoot(), recordSuccess: async () => {} });
    await writeFile(wire, `${row}\n`);
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const replay = await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) });
    expect(replay).toHaveLength(4);
    expect(replay.every((event) => event.project === "App")).toBe(true);
  });

  it("retains an old partial row when attribution was already available", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`,
    );
    const first = JSON.stringify(kimiTurn());
    const second = JSON.stringify(kimiTurn({ time: kimiTurn().time + 1000 }));
    await writeFile(wire, `${first}\n${second.slice(0, -2)}`);
    const partial = { complete: true };
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date("2026-10-01T00:00:00Z"),
        scanStatus: partial,
      }),
    ).toEqual([]);
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: partial,
      stateRoot: kimiStateRoot(),
      recordSuccess: async () => {},
    });

    await writeFile(wire, `${first}\n${second}\n`);
    expect(
      await collectKimiEvents({
        home,
        stateRoot: kimiStateRoot(),
        since: new Date(Date.now() + 60_000),
      }),
    ).toHaveLength(8);
  });

  it("replays pending sources when the configured home is relative", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const relativeHome = relative(process.cwd(), home);
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home: relativeHome, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    expect(await collectKimiEvents({ home: relativeHome, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(4);
  });

  it.each([
    "sessions/../outside/session-a/agents/main/wire.jsonl",
    "/outside/wire.jsonl",
    "C:/outside/wire.jsonl",
    "outside\\wire.jsonl",
    "outside//wire.jsonl",
    "./wire.jsonl",
    "outside/not-wire.jsonl",
    "outside/\0/wire.jsonl",
  ])("rejects unsafe pending-marker path %j", async (invalidFile) => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    const pendingDirectory = `${collectorStatePath(KIMI_PRODUCER_ID, kimiStateRoot(), "pending")}.d`;
    await mkdir(pendingDirectory, { recursive: true });
    const since = new Date(0).toISOString();
    const generation = "00000000-0000-4000-8000-000000000000";
    const name = `${createHash("sha256").update(`${invalidFile}\0${since}\0${generation}`).digest("hex")}.json`;
    await writeFile(
      join(pendingDirectory, name),
      `${JSON.stringify({ version: 1, file: invalidFile, since, generation })}\n`,
    );

    await expect(
      collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) }),
    ).rejects.toThrow("invalid shape");
  });

  it("compacts observed deferred generations while retaining a replayable marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "workspace", "session-a", "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    const directory = `${collectorStatePath(KIMI_PRODUCER_ID, kimiStateRoot(), "pending")}.d`;
    for (let i = 0; i < 4; i += 1) {
      await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
      expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    }
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(4);
  });

  it("defers a shallow future layout while advancing the checkpoint and replays after recognition", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const futureLayout = join(home, "sessions", "workspace", "session-a", "wire.jsonl");
    await mkdir(join(futureLayout, ".."), { recursive: true });
    await writeFile(futureLayout, `${JSON.stringify(kimiTurn())}\n`);
    await utimes(futureLayout, new Date(0), new Date(0));
    const discoveredSince = new Date(kimiTurn().time + 60_000);
    const status = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: discoveredSince, scanStatus: status })).toEqual([]);
    expect(status.complete).toBe(true);
    expect(canAdvanceCollectorCheckpoint({ dryRun: false, explicitSince: false }, { scanComplete: status.complete })).toBe(true);
    const pending = await readPendingSessions(kimiStateRoot());
    expect(pending.get("workspace/session-a/wire.jsonl")?.since).toBe(new Date(0).toISOString());

    const checkpointWrites = [];
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: status,
      stateRoot: kimiStateRoot(),
      recordSuccess: async (...args) => checkpointWrites.push(args),
    });
    expect(checkpointWrites).toHaveLength(1);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(pending);

    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const replayStatus = { complete: true };
    // Simulate a later collector release recognizing this same source path.
    const replay = await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(Date.now() + 60_000),
      scanStatus: replayStatus,
      resolveWireIdentity: (root, file) => ({
        ...kimiWireIdentity(root, file),
        sessionId: "session-a",
        agentId: "main",
      }),
    });
    expect(replay).toHaveLength(4);
    expect(replay.every((event) => event.project === "App")).toBe(true);
    expect(replayStatus.complete).toBe(true);
    await acknowledgeKimiEvents(kimiStateRoot(), replayStatus);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(new Map());
  });

  it("preserves deep archive and stray files without freezing canonical progress or accumulating markers", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const sourcePaths = [
      "wire.jsonl",
      "archive/old/workspace/session-a/agents/main/wire.jsonl",
      "stray/one/two/three/four/five/six/seven/eight/wire.jsonl",
      "workspace/session-a/agents/main/wire.jsonl",
    ];
    for (const path of sourcePaths) {
      const wire = join(home, "sessions", path);
      await mkdir(join(wire, ".."), { recursive: true });
      await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    }
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const directory = `${collectorStatePath(KIMI_PRODUCER_ID, kimiStateRoot(), "pending")}.d`;
    const firstSince = new Date("2026-04-01T00:00:00Z");
    for (let i = 0; i < 4; i += 1) {
      const status = { complete: true };
      const events = await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: i === 0 ? firstSince : new Date(0), scanStatus: status });
      expect(events).toHaveLength(4);
      expect(events.every((event) => event.metadata["session.id"] === "session-a")).toBe(true);
      expect(status.complete).toBe(true);
      const pending = await readPendingSessions(kimiStateRoot());
      expect([...pending.keys()].sort()).toEqual(sourcePaths.slice(0, 3).sort());
      expect([...pending.values()].every((entry) => entry.since === new Date(0).toISOString())).toBe(true);
      expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toHaveLength(3);
    }
  });

  it("blocks checkpoint advancement if a session directory disappears during traversal", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const sessionsRoot = join(home, "sessions");
    const child = join(sessionsRoot, "future");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "wire.jsonl"), `${JSON.stringify(kimiTurn())}\n`);
    const status = { complete: true };
    expect(await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(0),
      scanStatus: status,
      readSessionDirectory: async (directory, options) => {
        const entries = await readdir(directory, options);
        if (directory === sessionsRoot) await rm(child, { recursive: true });
        return entries;
      },
    })).toEqual([]);
    expect(status.complete).toBe(false);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(new Map());
    const checkpointWrites = [];
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: status,
      stateRoot: kimiStateRoot(),
      recordSuccess: async (...args) => checkpointWrites.push(args),
    });
    expect(checkpointWrites).toEqual([]);
  });

  it("blocks checkpoint advancement if a new unknown source disappears before open without a marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "future", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const turn = `${JSON.stringify(kimiTurn())}\n`;
    await writeFile(wire, turn);
    const status = { complete: true };
    const since = new Date(kimiTurn().time + 60_000);
    expect(await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since,
      scanStatus: status,
      resolveWireIdentity: (root, file) => {
        // Discovery has completed, but no durable marker or file handle exists.
        rmSync(file);
        return kimiWireIdentity(root, file);
      },
    })).toEqual([]);
    expect(status.complete).toBe(false);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(new Map());
    const checkpointWrites = [];
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus: status,
      stateRoot: kimiStateRoot(),
      recordSuccess: async (...args) => checkpointWrites.push(args),
    });
    expect(checkpointWrites).toEqual([]);

    await writeFile(wire, turn);
    const recovered = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since, scanStatus: recovered })).toEqual([]);
    expect(recovered.complete).toBe(true);
    expect((await readPendingSessions(kimiStateRoot())).get("future/wire.jsonl").since).toBe(new Date(0).toISOString());
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    expect(await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since,
      resolveWireIdentity: (root, file) => ({ ...kimiWireIdentity(root, file), sessionId: "session-a", agentId: "main" }),
    })).toHaveLength(4);
  });

  it("retains an unknown deleted source without freezing and compacts again when it returns", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "future", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    const pending = await readPendingSessions(kimiStateRoot());
    await rm(wire);
    const status = { complete: true };
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000), scanStatus: status })).toEqual([]);
    expect(status.complete).toBe(true);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(pending);
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) });
    const restored = (await readPendingSessions(kimiStateRoot())).get("future/wire.jsonl");
    expect(restored.since).toBe(new Date(0).toISOString());
    expect(restored.markerNames.size).toBe(1);
  });

  it("keeps unknown-layout dry runs immutable and preserves epoch for an incomplete older source", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const wire = join(home, "sessions", "future", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    const turn = JSON.stringify(kimiTurn());
    await writeFile(wire, turn.slice(0, -5));
    await utimes(wire, new Date(0), new Date(0));
    const since = new Date(Date.now() + 60_000);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since, dryRun: true })).toEqual([]);
    expect(await readPendingSessions(kimiStateRoot())).toEqual(new Map());
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since })).toEqual([]);
    const pending = await readPendingSessions(kimiStateRoot());
    expect(pending.get("future/wire.jsonl").since).toBe(new Date(0).toISOString());
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since, dryRun: true });
    expect(await readPendingSessions(kimiStateRoot())).toEqual(pending);
    await writeFile(wire, `${turn}\n`);
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const status = { complete: true };
    expect(await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since,
      scanStatus: status,
      resolveWireIdentity: (root, file) => ({ ...kimiWireIdentity(root, file), sessionId: "session-a", agentId: "main" }),
    })).toHaveLength(4);
    expect(status.complete).toBe(true);
  });

  it("retains a marker and blocks the checkpoint when a parent changes after open", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const agent = join(home, "sessions", "workspace", "session-a", "agents", "main");
    const original = `${agent}-original`;
    const outside = join(tempRoot, "outside");
    const wire = join(agent, "wire.jsonl");
    await mkdir(agent, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(join(outside, "wire.jsonl"), `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    const scanStatus = { complete: true };
    expect(await collectKimiEvents({
      home,
      stateRoot: kimiStateRoot(),
      since: new Date(Date.now() + 60_000),
      scanStatus,
      afterWireOpen: async () => {
        await rename(agent, original);
        await symlink(outside, agent);
      },
    })).toEqual([]);
    expect(scanStatus.complete).toBe(false);
    await finishKimiPass({
      args: { dryRun: false, explicitSince: false },
      passStartedAt: new Date(),
      scanStatus,
      stateRoot: kimiStateRoot(),
      recordSuccess: async () => { throw new Error("checkpoint should not advance"); },
    });
    await rm(agent);
    await rename(original, agent);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(4);
  });

  it("does not replay a pending file or directory replaced by a symlink", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "kimi-collector-"));
    const home = join(tempRoot, ".kimi-code");
    const agent = join(home, "sessions", "workspace", "session-a", "agents", "main");
    const wire = join(agent, "wire.jsonl");
    const outside = join(tempRoot, "outside");
    await mkdir(agent, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    await writeFile(join(outside, "wire.jsonl"), `${JSON.stringify(kimiTurn())}\n`);
    await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) });
    await writeFile(join(home, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session-a", workDir: "/Code/App" })}\n`);
    await rm(wire);
    await symlink(join(outside, "wire.jsonl"), wire);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) })).toEqual([]);
    await rm(agent, { recursive: true });
    await symlink(outside, agent);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(0) })).toEqual([]);
    await rm(agent);
    await mkdir(agent);
    await writeFile(wire, `${JSON.stringify(kimiTurn())}\n`);
    expect(await collectKimiEvents({ home, stateRoot: kimiStateRoot(), since: new Date(Date.now() + 60_000) })).toHaveLength(4);
  });
});

describe("ZCode exact usage telemetry", () => {
  it("honors ZCode's documented data-base override", () => {
    expect(defaultZcodeDbPath({ ZCODE_DATA_BASE_DIR: "/srv/zcode-data" })).toBe(
      "/srv/zcode-data/.zcode/cli/db/db.sqlite",
    );
    expect(defaultZcodeDbPath({ ZCODE_DB: "/srv/custom.sqlite" })).toBe(
      "/srv/custom.sqlite",
    );
  });

  it("subtracts both cache components from inclusive input", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      breakdown: { input: 30, output: 20, cacheRead: 60, cacheCreation: 10 },
      cacheBreakdownValid: true,
    });
  });

  it("retains the provider total when an invalid cache split exceeds input", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      breakdown: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
      cacheBreakdownValid: false,
    });
  });

  it("retains cache-only historical rows when the normalized input total is absent", () => {
    expect(
      zcodeTokenBreakdown({
        input_tokens: 0,
        output_tokens: 2,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      breakdown: { input: 0, output: 2, cacheRead: 20, cacheCreation: 5 },
      cacheBreakdownValid: true,
    });
  });

  it("normalizes Z.ai-family provider ids without flattening other providers", () => {
    expect(zcodeProviderName("z.ai")).toBe("zcode");
    expect(zcodeProviderName("bigmodel-coding-plan")).toBe("zcode");
    expect(zcodeProviderName("glm-5")).toBe("zcode");
    expect(zcodeProviderName("anthropic")).toBe("anthropic");
    expect(zcodeProviderName("google")).toBe("google-antigravity");
  });

  it("emits terminal request rows and keeps reasoning inside output", () => {
    const base = {
      id: "request-1",
      session_id: "session-1",
      query_source: "main_turn",
      provider_id: "z.ai",
      model_id: "glm-5",
      status: "completed",
      started_at: 1_779_256_800_000,
      completed_at: 1_779_256_801_000,
      input_tokens: 100,
      output_tokens: 25,
      reasoning_tokens: 7,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
      directory: "/Code/Usage-Monitor",
    };
    const events = parseZcodeModelUsageRows([base, { ...base, id: "running", status: "running" }]);
    expect(events.map((event) => [event.label, event.quantity])).toEqual([
      ["token:input", 30],
      ["token:output", 25],
      ["token:cacheRead", 60],
      ["token:cacheCreation", 10],
    ]);
    expect(events.every((event) => event.provider === "zcode")).toBe(true);
    expect(events.every((event) => event.service === "zcode-cli")).toBe(true);
    expect(events.every((event) => event.confidence === "actual")).toBe(true);
    expect(events.find((event) => event.label === "token:output")?.metadata.reasoningTokens).toBe(7);
    expect(events.find((event) => event.label === "token:output")?.quantity).toBe(25);
  });

  it("projects duration, TTFT, and terminal errors through the Sentry privacy bridge", () => {
    const events = parseZcodeModelUsageRows([{
      id: "request-error",
      session_id: "session-1",
      provider_id: "z.ai",
      model_id: "glm-5",
      status: "error",
      started_at: 1_779_256_800_000,
      completed_at: 1_779_256_801_000,
      duration_ms: 1000,
      time_to_first_token_ms: 125,
      error_type: "provider_error",
      finish_reason: "PRIVATE_FINISH_REASON",
      error_code: "PRIVATE_ERROR_CODE",
      input_tokens: 10,
      output_tokens: 2,
      reasoning_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }]);
    const [span] = collectorSentryEvents(events, {
      producerId: ZCODE_PRODUCER_ID,
      producerInstanceId: "test",
    });
    expect(span.kind).toBe("span");
    expect(span.durationMs).toBe(1000);
    expect(span.status).toEqual({ code: 2 });
    expect(span.attributes).toEqual(expect.arrayContaining([
      { key: "gen_ai.system", value: { stringValue: "zcode" } },
      { key: "ttft_ms", value: { stringValue: "125" } },
      { key: "error.type", value: { stringValue: "provider_error" } },
      { key: "gen_ai.usage.reasoning_count", value: { stringValue: "1" } },
    ]));
    expect(events.every((event) => !Object.hasOwn(event.metadata, "finishReason"))).toBe(true);
    expect(events.every((event) => !Object.hasOwn(event.metadata, "errorCode"))).toBe(true);
    expect(JSON.stringify(span)).not.toContain("PRIVATE_ERROR_CODE");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_FINISH_REASON");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_ERROR_CODE");
    const unsafeType = parseZcodeModelUsageRows([{
      id: "request-unsafe-error-type",
      session_id: "session-1",
      provider_id: "z.ai",
      model_id: "glm-5",
      status: "error",
      started_at: 1_779_256_800_000,
      input_tokens: 1,
      output_tokens: 1,
      error_type: "provider error: PRIVATE MESSAGE",
    }]);
    expect(unsafeType.every((event) => !Object.hasOwn(event.metadata, "errorType"))).toBe(true);
    expect(JSON.stringify(unsafeType)).not.toContain("PRIVATE MESSAGE");
  });

  it("reads the documented model_usage schema through a read-only join", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-collector-"));
    const dbPath = join(tempRoot, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session (id text PRIMARY KEY, project_id text, directory text);" +
        "CREATE TABLE model_usage (" +
        "id text PRIMARY KEY, attempt_index integer, session_id text, query_source text, provider_id text, model_id text, " +
        "variant text, agent text, mode text, task_type text, status text, started_at integer, completed_at integer, " +
        "duration_ms integer, time_to_first_token_ms integer, finish_reason text, tool_call_count integer, retry_count integer, " +
        "retryable integer, cancelled_by_user integer, context_exceeded integer, error_type text, error_code text, " +
        "input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_creation_input_tokens integer, " +
        "cache_read_input_tokens integer, provider_total_tokens integer, computed_total_tokens integer);",
    );
    db.prepare("INSERT INTO session (id, project_id, directory) VALUES (?, ?, ?)").run(
      "s1",
      "source-project-1",
      "/Code/ZCode-Demo",
    );
    db.prepare(
      "INSERT INTO model_usage (id, session_id, query_source, provider_id, model_id, task_type, status, " +
        "started_at, completed_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens, " +
        "reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "r1", "s1", "main_turn", "zai", "glm-5", "interactive", "completed",
      1_779_256_800_000, 1_779_256_801_000, 1000, 50, 100, 25, 7, 10, 60,
    );
    db.close();
    const rows = await readZcodeModelUsageRows(dbPath, new Date(0));
    expect(rows).toHaveLength(1);
    expect(rows[0].directory).toBe("/Code/ZCode-Demo");
    const events = await collectZcodeEvents({ dbPath, since: new Date(0) });
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.project === "ZCode-Demo")).toBe(true);
    expect(events.every((event) => event.metadata.sourceProjectId === "source-project-1")).toBe(true);
  });

  it("projects Kimi token calls to the Moonshot Sentry vendor", () => {
    const events = parseKimiUsageJsonl(JSON.stringify(kimiTurn()), {
      sessionKey: "s",
      sessionId: "s",
    });
    const [call] = collectorSentryEvents(events, {
      producerId: KIMI_PRODUCER_ID,
      producerInstanceId: "test",
    });
    expect(call.kind).toBe("log");
    expect(call.attributes).toContainEqual({
      key: "gen_ai.system",
      value: { stringValue: "moonshot" },
    });
  });
});

describe("telemetry v2 contract", () => {
  it("accepts both collectors' exact token events", () => {
    const kimiEvents = parseKimiUsageJsonl(JSON.stringify(kimiTurn()), {
      sessionKey: "s",
      sessionId: "s",
    });
    const zcodeEvents = parseZcodeModelUsageRows([{
      id: "r",
      session_id: "s",
      provider_id: "zai",
      model_id: "glm-5",
      status: "completed",
      started_at: 1_779_256_800_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }]);
    expect(
      UsageTelemetryV2BatchSchema.parse({
        schemaVersion: 2,
        producerId: KIMI_PRODUCER_ID,
        producerInstanceId: "test",
        events: kimiEvents,
      }).events,
    ).toHaveLength(4);
    expect(
      UsageTelemetryV2BatchSchema.parse({
        schemaVersion: 2,
        producerId: ZCODE_PRODUCER_ID,
        producerInstanceId: "test",
        events: zcodeEvents,
      }).events,
    ).toHaveLength(2);
  });
});

describe("scoped Sentry hub credentials", () => {
  it("loads a producer-specific bearer into process scope without persisting it", () => {
    const env = {
      COLLECTOR_SENTRY_ENABLED: "1",
      COLLECTOR_TELEMETRY_HUB_ENDPOINT: "https://telemetry.example",
    };
    const calls = [];
    expect(
      configureCollectorSentryToken(["KIMI_CODE_TELEMETRY_HUB_TOKEN"], {
        env,
        fleetSecretsGet: (name) => {
          calls.push(name);
          return "test-only-kimi-hub-bearer-0000000000000000";
        },
      }),
    ).toBe(true);
    expect(calls).toEqual(["KIMI_CODE_TELEMETRY_HUB_TOKEN"]);
    expect(env.COLLECTOR_TELEMETRY_HUB_TOKEN).toBe("test-only-kimi-hub-bearer-0000000000000000");
  });

  it("does not read a secret while Sentry forwarding is disabled", () => {
    let called = false;
    expect(
      configureCollectorSentryToken(["ZCODE_TELEMETRY_HUB_TOKEN"], {
        env: { COLLECTOR_SENTRY_ENABLED: "0" },
        fleetSecretsGet: () => {
          called = true;
          return "unused";
        },
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });

  it("does not read a hub secret for direct Sentry delivery", () => {
    let called = false;
    expect(
      configureCollectorSentryToken(["ZCODE_TELEMETRY_HUB_TOKEN"], {
        env: { COLLECTOR_SENTRY_ENABLED: "1" },
        fleetSecretsGet: () => {
          called = true;
          return "unused";
        },
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});
