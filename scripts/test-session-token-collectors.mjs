#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageTelemetryV2BatchSchema } from "@jaywedgeworth22/congress-trading-shared";
import { fleetIngestJobs } from "./fleet-usage-collector.mjs";
import { quotaEventsFromMiniMax } from "./minimax-usage-collector.mjs";
import {
  ANTIGRAVITY_PRODUCER_ID,
  CLAUDE_PRODUCER_ID,
  CODEX_PRODUCER_ID,
  COPILOT_PRODUCER_ID,
  DEEPSEEK_PRODUCER_ID,
  GROK_COST_USD_TICKS,
  GROK_PRODUCER_ID,
  chunkEvents,
  postUsageBatches,
  isCompleteUsageIngestAck,
  parseAntigravityStatuslineJsonl,
  parseClaudeSessionJsonl,
  parseCodexJsonl,
  parseCopilotEventsJsonl,
  parseDeepSeekSessionJsonl,
  parseGrokUpdatesJsonl,
  splitInclusiveCache,
} from "./lib/session-token-collectors.mjs";
import {
  DEFAULT_COLLECTOR_LOOKBACK_DAYS,
  COLLECTOR_STATE_OVERLAP_MINUTES,
  botFleetChildExclusionEnabled,
  canAdvanceCollectorCheckpoint,
  codexSessionKeyFor,
  isBotFleetManagedCodexSession,
  isBotFleetSessionPath,
  parseCollectorArgs,
  readIfFresh,
  recordCollectorSuccess,
  resolveCollectorArgs,
  sessionKeyFor,
  walkFiles,
} from "./lib/run-session-token-collector.mjs";
import {
  observedPlanEvent,
  planTypeFromCodexAuth,
} from "./lib/codex-observed-plan.mjs";

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
}

assert(
  isCompleteUsageIngestAck(
    { received: 4, persisted: 0, duplicates: 4, pruned: 0, rejected: 0 },
    4,
  ),
  "complete duplicate acknowledgements are accepted",
);
assert(
  !isCompleteUsageIngestAck({ received: 4, persisted: 4, rejected: 0 }, 4),
  "partial 2xx acknowledgement bodies are never assumed delivered",
);

const split = splitInclusiveCache({
  input: 30297,
  output: 386,
  cacheRead: 9984,
  cacheCreation: 0,
});
assert(split.input === 30297 - 9984, "codex uncached input");
assert(split.cacheRead === 9984, "codex cache read");
assert(split.output === 386, "codex output");

const antigravityStatusEvents = parseAntigravityStatuslineJsonl(
  JSON.stringify({
    type: "antigravity.statusline.usage",
    occurredAt: "2026-09-13T12:00:00.000Z",
    sessionHash: "a".repeat(64),
    signature: "b".repeat(64),
    model: "Gemini 3.8 Flash (High)",
    breakdownComplete: true,
    usage: { input: 63_382, output: 346, cacheRead: 20_857, cacheCreation: 0 },
  }),
);
assert(antigravityStatusEvents.length === 3, "Antigravity status line emits exact token splits");
assert(
  antigravityStatusEvents.find((event) => event.label === "token:input")?.quantity === 63_382,
  "Antigravity status line preserves exclusive input tokens",
);
assert(
  antigravityStatusEvents.every((event) => event.confidence === "actual"),
  "Antigravity status line counts are provider-reported",
);
assert(
  !JSON.stringify(antigravityStatusEvents).includes("transcript"),
  "Antigravity events omit transcript content and paths",
);

const statuslineStateRoot = await mkdtemp(join(tmpdir(), "ag-statusline-"));
try {
  const sink = join(dirname(fileURLToPath(import.meta.url)), "antigravity-statusline-telemetry.mjs");
  const runStatusline = (contextWindow, agentState) => execFileSync(
    process.execPath,
    [sink],
    {
      env: { ANTIGRAVITY_TELEMETRY_STATE_DIR: statuslineStateRoot },
      input: JSON.stringify({
        conversation_id: "private-session-id",
        cwd: "/private/workspace",
        model: { id: "gemini-3.8-flash" },
        agent_state: agentState,
        context_window: contextWindow,
      }),
    },
  );
  runStatusline({
    total_input_tokens: 500,
    total_output_tokens: 100,
    current_usage: {
      input_tokens: 80,
      output_tokens: 20,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 0,
    },
  }, "tool_use");
  runStatusline({
    total_input_tokens: 650,
    total_output_tokens: 130,
    current_usage: {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    },
  }, "idle");
  runStatusline({
    total_input_tokens: 800,
    total_output_tokens: 160,
    current_usage: {
      input_tokens: 10,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
  }, "idle");
  runStatusline({
    total_input_tokens: 50,
    total_output_tokens: 5,
    current_usage: {
      input_tokens: 50,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }, "tool_use");
  const captured = await readFile(join(statuslineStateRoot, "usage.jsonl"), "utf8");
  const capturedRows = captured.trim().split("\n").map((line) => JSON.parse(line));
  assert(capturedRows.length === 4, "status line captures each cumulative-token change and reset");
  assert(capturedRows[0].breakdownComplete === false, "first install does not assign mixed history to the current request");
  assert(capturedRows[1].breakdownComplete === true, "matching current usage preserves exact cache split");
  assert(capturedRows[2].breakdownComplete === false, "missed requests retain exact total deltas without inventing cache split");
  assert(
    capturedRows[2].usage.input === 150 && capturedRows[2].usage.output === 30,
    "unreconciled status update uses cumulative input and output deltas",
  );
  assert(
    capturedRows[3].counterGeneration === 1 &&
      capturedRows[3].inputDelta === 50 && capturedRows[3].outputDelta === 5,
    "counter reset starts a new generation without waiting for the old high-water mark",
  );
  await rm(join(statuslineStateRoot, "capture-state.json"), { force: true });
  runStatusline({
    total_input_tokens: 50,
    total_output_tokens: 5,
    current_usage: {
      input_tokens: 50,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }, "tool_use");
  const replayedRows = (await readFile(join(statuslineStateRoot, "usage.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert(
    replayedRows.length === 4,
    "status-line state loss recovers from the durable snapshot without appending a conflicting retry",
  );
  assert(!captured.includes("private-session-id"), "status line hashes the private session id");
  assert(!captured.includes("/private/workspace"), "status line omits workspace paths");
  const capturedEvents = parseAntigravityStatuslineJsonl(captured);
  const firstCaptureEvents = capturedEvents.filter((event) =>
    event.producerKeyRef === "unknown-antigravity-model" &&
    (event.quantity === 500 || event.quantity === 100)
  );
  assert(
    firstCaptureEvents.length === 2 && firstCaptureEvents.every((event) =>
      event.producerKeyRef === "unknown-antigravity-model" &&
      event.metadata.modelAttributionComplete === false
    ),
    "first-install mixed history keeps exact totals but unknown model attribution",
  );
  assert(
    capturedEvents.some((event) =>
      event.label === "token:inputUnsplit" && event.metadata.tokenBreakdownComplete === false
    ),
    "unreconciled input remains exact total usage with incomplete cost provenance",
  );
} finally {
  await rm(statuslineStateRoot, { recursive: true, force: true });
}

const minimaxQuotaEvents = quotaEventsFromMiniMax(
  {
    model_remains: [
      {
        model_name: "MiniMax-M3",
        end_time: 1789293600000,
        current_interval_remaining_percent: 88,
        weekly_end_time: 1789344000000,
        current_weekly_remaining_percent: 93,
      },
    ],
  },
  new Date("2026-09-13T12:00:00.000Z"),
);
assert(minimaxQuotaEvents.length === 2, "MiniMax emits rolling and weekly quota windows");
assert(minimaxQuotaEvents[0].credits === 88, "MiniMax remaining percent preserved");
assert(minimaxQuotaEvents[0].producerKeyRef === "MiniMax-M3", "MiniMax model preserved");
const sameMiniMaxObservation = quotaEventsFromMiniMax(
  { model_remains: [{
    model_name: "MiniMax-M3",
    end_time: 1789293600000,
    current_interval_remaining_percent: 88,
  }] },
  new Date("2026-09-13T12:00:00.000Z"),
);
const laterMiniMaxObservation = quotaEventsFromMiniMax(
  { model_remains: [{
    model_name: "MiniMax-M3",
    end_time: 1789293600000,
    current_interval_remaining_percent: 87,
  }] },
  new Date("2026-09-13T12:01:00.000Z"),
);
assert(
  minimaxQuotaEvents[0].eventId === sameMiniMaxObservation[0].eventId,
  "MiniMax exact observation retries keep the same event id",
);
assert(
  minimaxQuotaEvents[0].eventId !== laterMiniMaxObservation[0].eventId,
  "MiniMax polls in the same quota window use distinct observation ids",
);
assert(
  UsageTelemetryV2BatchSchema.safeParse({
    schemaVersion: 2,
    producerId: "minimax-code",
    producerInstanceId: "test-host",
    events: minimaxQuotaEvents,
  }).success,
  "MiniMax quota batch schema valid",
);

assert(
  isBotFleetSessionPath("/Users/test/.botfleet/workspaces/child/session.jsonl.zstd") &&
    isBotFleetSessionPath("/tmp/.botfleet-workspaces-child/session.jsonl.zstd") &&
    !isBotFleetSessionPath("/Users/test/.dsh/sessions/local/session.jsonl.zstd"),
  "BotFleet child-path detection covers both managed workspace layouts",
);

const traversalRoot = await mkdtemp(join(tmpdir(), "collector-traversal-"));
try {
  const notDirectory = join(traversalRoot, "not-a-directory");
  await writeFile(notDirectory, "fixture");
  let traversalErrors = 0;
  const traversed = await walkFiles(notDirectory, {
    suffix: ".jsonl",
    onTraversalError: () => { traversalErrors += 1; },
  });
  assert(
    traversed.length === 0 && traversalErrors === 1,
    "directory traversal errors mark a collector scan incomplete",
  );
  traversalErrors = 0;
  await walkFiles(join(traversalRoot, "provider-not-installed"), {
    suffix: ".jsonl",
    onTraversalError: () => { traversalErrors += 1; },
  });
  assert(traversalErrors === 0, "a missing provider root remains a valid empty scan");
} finally {
  await rm(traversalRoot, { recursive: true, force: true });
}

const codexFixture = [
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T12:00:00.000Z",
    payload: { model: "gpt-5.6-sol" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:01.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cached_input_tokens: 200,
          cache_write_input_tokens: 50,
          reasoning_output_tokens: 20,
          total_tokens: 1100,
        },
      },
    },
  }),
].join("\n");

const codexEvents = parseCodexJsonl(codexFixture, { sessionKey: "test/session.jsonl" });
assert(codexEvents.length === 4, `codex event count ${codexEvents.length}`);
assert(
  codexEvents.every((e) => e.producerKeyRef === "gpt-5.6-sol"),
  "codex model from turn_context"
);
assert(
  codexEvents.find((e) => e.label === "token:input")?.quantity === 800,
  "codex uncached input quantity"
);
assert(
  codexEvents.find((e) => e.label === "token:cacheRead")?.quantity === 200,
  "codex cache read quantity"
);
assert(
  codexEvents.find((e) => e.label === "token:cacheCreation")?.quantity === 50,
  "codex cache write quantity"
);
assert(
  new Set(codexEvents.map((e) => e.eventId)).size === codexEvents.length,
  "codex eventIds unique"
);

const lastUsage = {
  input_tokens: 1000,
  output_tokens: 100,
  cached_input_tokens: 200,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 20,
  total_tokens: 1100,
};
const sameTotal = {
  input_tokens: 1000,
  cached_input_tokens: 200,
  output_tokens: 100,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 20,
  total_tokens: 1100,
};
const nextTotal = {
  input_tokens: 2500,
  cached_input_tokens: 400,
  output_tokens: 180,
  cache_write_input_tokens: 50,
  reasoning_output_tokens: 30,
  total_tokens: 2680,
};
const replayFixture = [
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T12:00:00.000Z",
    payload: { model: "gpt-5.6-sol" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:01.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: lastUsage, total_token_usage: sameTotal },
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:02.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: lastUsage, total_token_usage: sameTotal },
    },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T12:00:03.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1500,
          output_tokens: 80,
          cached_input_tokens: 200,
          cache_write_input_tokens: 0,
          total_tokens: 1580,
        },
        total_token_usage: nextTotal,
      },
    },
  }),
].join("\n");
const replayEvents = parseCodexJsonl(replayFixture, { sessionKey: "test/replay.jsonl" });
assert(
  replayEvents.length === 7,
  `codex replay skip ${replayEvents.length}`
);
assert(
  replayEvents.filter((e) => e.label === "token:input").reduce((sum, e) => sum + e.quantity, 0) ===
    800 + 1300,
  "codex replay does not double last_token_usage"
);

function fakeJwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}
const observedPlus = planTypeFromCodexAuth({
  tokens: {
    id_token: fakeJwt({
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
  },
});
assert(observedPlus === "plus", `codex observed plan ${observedPlus}`);
assert(planTypeFromCodexAuth({ tokens: {} }) === null, "missing id_token is not a plan");
const planEvent = observedPlanEvent({
  planType: "plus",
  occurredAtIso: "2026-09-03T12:00:00.000Z",
});
assert(planEvent.label === "observed-plan", "observed-plan label");
assert(planEvent.producerKeyRef === "plus", "observed-plan key");
assert(planEvent.metricType === "quota_sync", "observed-plan metric");
assert(
  !JSON.stringify(planEvent).includes("eyJ"),
  "observed-plan event must not include a JWT"
);
UsageTelemetryV2BatchSchema.parse({
  schemaVersion: 2,
  producerId: CODEX_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: [planEvent],
});

assert(DEFAULT_COLLECTOR_LOOKBACK_DAYS === 180, "default collector lookback days");
const defaultArgs = parseCollectorArgs(["node", "codex-usage-collector.mjs"]);
const defaultAgeMs = Date.now() - defaultArgs.since.getTime();
const dayMs = 86_400_000;
assert(
  defaultAgeMs > 170 * dayMs && defaultAgeMs < 190 * dayMs,
  `default since is ~180d, not UTC month start (${defaultArgs.since.toISOString()})`
);
const sevenDayArgs = parseCollectorArgs(["node", "x", "--days", "7"]);
assert(
  Math.abs(Date.now() - sevenDayArgs.since.getTime() - 7 * dayMs) < 5_000,
  "--days 7"
);
const sinceArgs = parseCollectorArgs(["node", "x", "--since", "2026-06-15T00:00:00.000Z"]);
assert(sinceArgs.since.toISOString() === "2026-06-15T00:00:00.000Z", "--since ISO");
assert(sinceArgs.explicitSince === true, "--since marks explicit backfill");

const stateRoot = await mkdtemp(join(tmpdir(), "usage-collector-state-"));
try {
  const successfulThrough = new Date("2026-09-13T12:00:00.000Z");
  await recordCollectorSuccess(CODEX_PRODUCER_ID, successfulThrough, { stateRoot });
  const resumed = await resolveCollectorArgs(
    ["node", "codex-usage-collector.mjs"],
    CODEX_PRODUCER_ID,
    { stateRoot, now: new Date("2026-09-13T13:00:00.000Z") },
  );
  assert(resumed.resumedFromState === true, "collector resumes from durable success state");
  assert(
    resumed.since.toISOString() ===
      new Date(successfulThrough.getTime() - COLLECTOR_STATE_OVERLAP_MINUTES * 60_000).toISOString(),
    "collector replays the bounded overlap",
  );
  const explicit = await resolveCollectorArgs(
    ["node", "codex-usage-collector.mjs", "--days", "7"],
    CODEX_PRODUCER_ID,
    { stateRoot, now: new Date("2026-09-13T13:00:00.000Z") },
  );
  assert(explicit.resumedFromState === false, "explicit backfill bypasses collector state");
  assert(
    !canAdvanceCollectorCheckpoint(explicit),
    "explicit backfill cannot advance the recurring checkpoint",
  );
  const persistedState = JSON.parse(
    await readFile(join(stateRoot, `${CODEX_PRODUCER_ID}.json`), "utf8"),
  );
  assert(
    persistedState.successfulThrough === successfulThrough.toISOString(),
    "collector success state persists atomically",
  );
  await writeFile(
    join(stateRoot, `${CODEX_PRODUCER_ID}.json`),
    `${JSON.stringify({
      version: 1,
      producerId: CODEX_PRODUCER_ID,
      successfulThrough: "2026-09-14T13:00:00.000Z",
    })}\n`,
  );
  const futureState = await resolveCollectorArgs(
    ["node", "codex-usage-collector.mjs"],
    CODEX_PRODUCER_ID,
    { stateRoot, now: new Date("2026-09-13T13:00:00.000Z") },
  );
  assert(!futureState.resumedFromState, "future collector checkpoint is rejected");
  let readFailed = false;
  await readIfFresh(join(stateRoot, "missing.jsonl"), {
    onReadError: () => { readFailed = true; },
  });
  assert(readFailed, "unreadable scan inputs are surfaced to the collector");
  assert(
    !canAdvanceCollectorCheckpoint(defaultArgs, { scanComplete: false }),
    "incomplete scans cannot advance the recurring checkpoint",
  );
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

const botFleetSessionMeta = JSON.stringify({
  type: "session_meta",
  payload: {
    originator: "botfleet",
    cwd: "/Users/jay/.botfleet/workspaces/test",
  },
});
assert(
  isBotFleetManagedCodexSession(botFleetSessionMeta),
  "BotFleet Codex child sessions are identified before standalone ingest",
);
assert(
  !botFleetChildExclusionEnabled({}),
  "BotFleet child exclusion stays gated until durable BotFleet delivery is active",
);
assert(
  botFleetChildExclusionEnabled({ USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN: "1" }),
  "BotFleet child exclusion requires the explicit activation flag",
);
assert(
  !isBotFleetManagedCodexSession(
    JSON.stringify({ type: "session_meta", payload: { originator: "codex_cli_rs", cwd: "/tmp/test" } }),
  ),
  "standalone Codex sessions remain eligible",
);

const codexHome = "/Users/jay/.codex";
const rolloutName =
  "rollout-2026-08-22T13-02-51-5973b6c0-94b8-487b-a530-2aeb6098ae0e.jsonl";
const liveRollout = join(codexHome, "sessions", "2026", "08", "22", rolloutName);
const flatArchive = join(codexHome, "archived_sessions", rolloutName);
const nestedArchive = join(codexHome, "archived_sessions", "2026", "08", "22", rolloutName);
assert(
  sessionKeyFor(codexHome, liveRollout) !== sessionKeyFor(codexHome, flatArchive),
  "raw relative keys change after Codex flatten-archive"
);
assert(
  codexSessionKeyFor(codexHome, liveRollout) === `sessions/2026/08/22/${rolloutName}`,
  "live Codex sessionKey"
);
assert(
  codexSessionKeyFor(codexHome, flatArchive) === codexSessionKeyFor(codexHome, liveRollout),
  "flattened archive remaps to the live sessions/YYYY/MM/DD key"
);
assert(
  codexSessionKeyFor(codexHome, nestedArchive) === codexSessionKeyFor(codexHome, liveRollout),
  "nested archive remaps to the same live key"
);
const liveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: codexSessionKeyFor(codexHome, liveRollout),
});
const rawArchiveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: sessionKeyFor(codexHome, flatArchive),
});
const remappedArchiveParsed = parseCodexJsonl(codexFixture, {
  sessionKey: codexSessionKeyFor(codexHome, flatArchive),
});
assert(
  liveParsed[0].eventId !== rawArchiveParsed[0].eventId,
  "path-based sessionKey would persist archive as new events"
);
assert(
  liveParsed[0].eventId === remappedArchiveParsed[0].eventId,
  "normalized archive key is idempotent with the live ingest"
);

const grokFixture = JSON.stringify({
  method: "session/update",
  timestamp: "2026-08-01T12:00:00.000Z",
  params: {
    sessionId: "sess-test",
    update: {
      sessionUpdate: "turn_completed",
      usage: {
        inputTokens: 10000,
        outputTokens: 500,
        cachedReadTokens: 2000,
        cacheCreationTokens: 100,
        reasoningTokens: 50,
        totalTokens: 10500,
        costUsdTicks: 2 * GROK_COST_USD_TICKS,
        modelUsage: {
          "grok-4.6-build": {
            inputTokens: 10000,
            outputTokens: 500,
            cachedReadTokens: 2000,
            cacheCreationTokens: 100,
            reasoningTokens: 50,
            totalTokens: 10500,
            costUsdTicks: 2 * GROK_COST_USD_TICKS,
          },
        },
      },
    },
  },
});

const grokEvents = parseGrokUpdatesJsonl(grokFixture, {
  sessionKey: "sessions/cwd/sess/updates.jsonl",
});
const grokTokens = grokEvents.filter((e) => e.metricType === "usage");
const grokCosts = grokEvents.filter((e) => e.metricType === "cost");
assert(grokTokens.length === 4, `grok token events ${grokTokens.length}`);
assert(grokCosts.length === 1, `grok cost events ${grokCosts.length}`);
assert(grokTokens[0].producerKeyRef === "grok-4.6-build", "grok model");
assert(
  grokTokens.find((e) => e.label === "token:input")?.quantity === 8000,
  "grok uncached input"
);
assert(grokCosts[0].costUsd === 2, "grok ticks to usd");
assert(grokEvents.every((e) => e.billingMode === "estimated"), "never cash");

const skipIncomplete = parseGrokUpdatesJsonl(
  JSON.stringify({
    method: "session/update",
    timestamp: "2026-08-01T12:00:00.000Z",
    params: { update: { sessionUpdate: "agent_message_chunk" } },
  }),
  { sessionKey: "x" }
);
assert(skipIncomplete.length === 0, "in-progress grok turns ignored");

const copilotFirst = {
  type: "session.shutdown",
  id: "shut-1",
  timestamp: "2026-08-01T12:00:00.000Z",
  data: {
    modelMetrics: {
      "deepseek-v4-pro": {
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 200,
          cacheWriteTokens: 50,
          reasoningTokens: 40,
        },
      },
    },
  },
};
const copilotReplay = {
  ...copilotFirst,
  id: "shut-2",
  timestamp: "2026-08-01T12:05:00.000Z",
};
const copilotNext = {
  type: "session.shutdown",
  id: "shut-3",
  timestamp: "2026-08-01T12:10:00.000Z",
  data: {
    modelMetrics: {
      "deepseek-v4-pro": {
        inputTokens: 2500,
        outputTokens: 180,
        cacheReadTokens: 400,
        cacheWriteTokens: 50,
      },
    },
  },
};
const copilotEvents = parseCopilotEventsJsonl(
  [JSON.stringify(copilotFirst), JSON.stringify(copilotReplay), JSON.stringify(copilotNext)].join(
    "\n"
  ),
  { sessionKey: "session-state/abc/events.jsonl" }
);
assert(copilotEvents.length === 7, `copilot event count ${copilotEvents.length}`);
assert(
  copilotEvents.every((e) => e.producerKeyRef === "deepseek-v4-pro"),
  "copilot model"
);
assert(
  copilotEvents.filter((e) => e.label === "token:input").reduce((sum, e) => sum + e.quantity, 0) ===
    750 + 1300,
  "copilot shutdown deltas, not cumulative double-count"
);
assert(
  copilotEvents.find((e) => e.label === "token:cacheRead")?.quantity === 200,
  "copilot first cache read"
);
const copilotPublished = parseCopilotEventsJsonl(
  JSON.stringify({
    type: "session.shutdown",
    timestamp: "2026-05-07T10:57:19.746Z",
    data: {
      modelMetrics: {
        "claude-opus-4.7": {
          usage: {
            inputTokens: 23399,
            outputTokens: 2994,
            cacheReadTokens: 10069,
            cacheWriteTokens: 13324,
            reasoningTokens: 0,
          },
        },
      },
    },
  }),
  { sessionKey: "ccusage-1174" }
);
const copilotPublishedInput = copilotPublished.find((e) => e.label === "token:input")?.quantity ?? 0;
assert(
  copilotPublishedInput === 6,
  `copilot inputTokens includes cache writes; expected 6 uncached, got ${copilotPublishedInput}`
);
assert(
  copilotPublished.find((e) => e.label === "token:cacheRead")?.quantity === 10069,
  "copilot published cache read"
);
assert(
  copilotPublished.find((e) => e.label === "token:cacheCreation")?.quantity === 13324,
  "copilot published cache write"
);
assert(
  copilotEvents.every((e) => e.billingMode === "estimated" && e.provider === "github-copilot"),
  "copilot never cash"
);
assert(
  parseCopilotEventsJsonl(
    JSON.stringify({
      type: "assistant.message",
      data: { outputTokens: 12, model: "gpt-5.4" },
    }),
    { sessionKey: "x" }
  ).length === 0,
  "copilot per-message output is not ingested (would double-count shutdown totals)"
);

const batch = {
  schemaVersion: 2,
  producerId: CODEX_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: codexEvents,
};
const parsed = UsageTelemetryV2BatchSchema.safeParse(batch);
assert(parsed.success, `codex batch schema ${parsed.success ? "" : JSON.stringify(parsed.error)}`);

const grokBatch = {
  schemaVersion: 2,
  producerId: GROK_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: grokEvents,
};
const grokParsed = UsageTelemetryV2BatchSchema.safeParse(grokBatch);
assert(
  grokParsed.success,
  `grok batch schema ${grokParsed.success ? "" : JSON.stringify(grokParsed.error)}`
);

const copilotBatch = {
  schemaVersion: 2,
  producerId: COPILOT_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: copilotEvents,
};
const copilotParsed = UsageTelemetryV2BatchSchema.safeParse(copilotBatch);
assert(
  copilotParsed.success,
  `copilot batch schema ${copilotParsed.success ? "" : JSON.stringify(copilotParsed.error)}`
);

const chunks = chunkEvents(new Array(250).fill(codexEvents[0]));
assert(chunks.length === 3, `chunk count ${chunks.length}`);
assert(chunks[0].length === 100 && chunks[2].length === 50, "chunk sizes");


// Claude Code Tests
const claudeFixture = [
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-20T14:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 1500,
        output_tokens: 450,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
        speed: "fast",
        output_tokens_details: { thinking_tokens: 120 },
      },
    },
  }),
].join("\n");

const claudeEvents = parseClaudeSessionJsonl(claudeFixture, { sessionKey: "test/claude-session.jsonl" });
assert(claudeEvents.length === 4, `claude event count ${claudeEvents.length}`);
assert(claudeEvents[0].producerKeyRef === "claude-opus-5", "claude model parsed");
assert(claudeEvents.find((e) => e.label === "token:input")?.quantity === 1200, "claude uncached input quantity");
assert(claudeEvents.find((e) => e.label === "token:cacheRead")?.quantity === 300, "claude cache read quantity");
assert(claudeEvents.find((e) => e.label === "token:cacheCreation")?.quantity === 200, "claude cache write quantity");
assert(claudeEvents.find((e) => e.label === "token:output")?.quantity === 450, "claude output quantity");

const claudeBatch = {
  schemaVersion: 2,
  producerId: CLAUDE_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: claudeEvents,
};
assert(UsageTelemetryV2BatchSchema.safeParse(claudeBatch).success, "claude batch schema valid");

// DeepSeek Tests
const dsFixture = [
  JSON.stringify({
    model: "deepseek-v4-pro",
    timestamp: "2026-08-20T16:00:00.000Z",
    usage: {
      prompt_tokens: 800,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 150,
    },
  }),
].join("\n");

const dsEvents = parseDeepSeekSessionJsonl(dsFixture, { sessionKey: "test/ds-session.jsonl" });
assert(dsEvents.length === 3, `deepseek event count ${dsEvents.length}`);
assert(dsEvents[0].producerKeyRef === "deepseek-v4-pro", "deepseek model parsed");
assert(dsEvents[0].provider === "deepseek", "deepseek provider");

const dshFixture = JSON.stringify({
  type: "assistant/message",
  time: 1789281924151,
  data: {
    message: {
      id: "message-1",
      source: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    },
    usage: {
      inputTokens: 2667,
      outputTokens: 227,
      cacheReadTokens: 7296,
      reasoningTokens: 71,
    },
  },
});
const dshEvents = parseDeepSeekSessionJsonl(dshFixture, { sessionKey: "test/dsh.zstd" });
assert(dshEvents.length === 3, `DSH event count ${dshEvents.length}`);
assert(
  dshEvents.find((event) => event.label === "token:input")?.quantity === 2667,
  "DSH inputTokens is exclusive of cache reads",
);
assert(
  dshEvents.find((event) => event.label === "token:cacheRead")?.quantity === 7296,
  "DSH cache reads remain separate when larger than input",
);
assert(
  dshEvents.find((event) => event.label === "token:output")?.metadata.reasoningTokens === 71,
  "DSH preserves reasoning-token detail without double-counting output",
);
assert(
  dshEvents.every((event) => event.confidence === "actual"),
  "DSH marks provider-reported token counts actual",
);

const dsBatch = {
  schemaVersion: 2,
  producerId: DEEPSEEK_PRODUCER_ID,
  producerInstanceId: "test-host",
  events: dsEvents,
};
assert(UsageTelemetryV2BatchSchema.safeParse(dsBatch).success, "deepseek batch schema valid");

const quotaEvent = {
  eventId: "agy-quota:gemini-weekly:2026-08-26T00:00:00Z",
  provider: "google-antigravity",
  service: "antigravity-cli",
  label: "Gemini Models (weekly)",
  metricType: "quota",
  billingMode: "actual",
  confidence: "actual",
  limit: 100,
  credits: 93,
  occurredAt: "2026-08-26T00:00:00.000Z",
};
const fleetJobs = fleetIngestJobs({
  quotaEvents: [quotaEvent],
  sessionResults: {
    antigravity: antigravityStatusEvents,
    claude: claudeEvents,
    codex: codexEvents,
    grok: grokEvents,
    copilot: copilotEvents,
    deepseek: dsEvents,
  },
});
assert(
  fleetJobs.every((job) => job.producerId !== "fleet-usage-collector"),
  "fleet collector must not post a synthetic fleet-usage-collector producerId"
);
assert(
  fleetJobs.find((job) => job.producerId === ANTIGRAVITY_PRODUCER_ID)?.events[0] ===
    quotaEvent,
  "Antigravity quota keeps the antigravity-cli producer namespace"
);
assert(
  fleetJobs.find((job) => job.producerId === CLAUDE_PRODUCER_ID)?.events === claudeEvents,
  "Claude batch uses claude-code"
);
assert(
  fleetJobs.find((job) => job.producerId === CODEX_PRODUCER_ID)?.events === codexEvents,
  "Codex batch uses openai-codex"
);
assert(
  fleetJobs.find((job) => job.producerId === GROK_PRODUCER_ID)?.events === grokEvents,
  "Grok batch uses grok-build"
);
assert(
  fleetJobs.find((job) => job.producerId === COPILOT_PRODUCER_ID)?.events ===
    copilotEvents,
  "Copilot batch uses github-copilot"
);
assert(
  fleetJobs.find((job) => job.producerId === DEEPSEEK_PRODUCER_ID)?.events === dsEvents,
  "DeepSeek batch uses deepseek-dsh"
);
for (const job of fleetJobs) {
  assert(
    UsageTelemetryV2BatchSchema.safeParse({
      schemaVersion: 2,
      producerId: job.producerId,
      producerInstanceId: "test-host",
      events: job.events,
    }).success,
    `fleet ${job.producerId} batch schema valid`
  );
}
assert(fleetIngestJobs({ quotaEvents: [], sessionResults: {} }).length === 0, "empty jobs");

// Main-guard idiom audit.  A collector's entrypoint guard decides whether the
// CLI body runs at all, so getting it wrong fails in the worst possible shape:
// silent, exit 0, no output, and a LaunchAgent that reports success forever
// while telemetry quietly stops arriving.
//
// Two forms have bitten this repo already:
//   * `process.argv[1].endsWith("<bare-filename>.mjs")` -- fired while the TEST
//     file was running, because "test-r2-weekly-archive.mjs" ends with
//     "r2-weekly-archive.mjs"; importing the module ran a real archive against
//     the ambient environment (fixed in #1383).
//   * `import.meta.url.endsWith(process.argv[1])` -- `import.meta.url`
//     percent-encodes the path and `process.argv[1]` does not, so it is FALSE
//     for any checkout whose path contains a space, #, ? or %.  This fleet has
//     such paths.
//
// The correct idiom, used by the rest of scripts/, compares resolved URLs:
//   import.meta.url === pathToFileURL(process.argv[1]).href
const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const guardOffenders = [];
for (const entry of readdirSync(scriptsDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
  const file = join(entry.parentPath ?? entry.path ?? scriptsDir, entry.name);
  // Skip this file: the patterns below are the audit's own regex literals.
  if (file === fileURLToPath(import.meta.url)) continue;
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    // Skip comments -- the fixes themselves quote the bad idiom to explain it.
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    if (/import\.meta\.url\.endsWith\s*\(/.test(code)) {
      guardOffenders.push(`${file}:${i + 1} import.meta.url.endsWith(...)`);
    }
    if (/process\.argv\[1\]\s*\.endsWith\s*\(/.test(code)) {
      guardOffenders.push(`${file}:${i + 1} process.argv[1].endsWith(...)`);
    }
  }
}
assert(
  guardOffenders.length === 0,
  `fragile main guard(s) -- use import.meta.url === pathToFileURL(process.argv[1]).href:\n  ${guardOffenders.join("\n  ")}`
);

// UM-1469: one idempotency_conflict event must not poison the whole batch.
{
  const poisonId = "evt-poison";
  const events = Array.from({ length: 7 }, (_, i) => ({
    eventId: i === 4 ? poisonId : `evt-${i}`,
    metricType: "usage",
    label: "token:input",
  }));
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.events.length);
    if (body.events.some((e) => e.eventId === poisonId)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "idempotency_conflict", message: 'Idempotency key collision for "abc".' },
        }),
        { status: 409 }
      );
    }
    const n = body.events.length;
    return new Response(
      JSON.stringify({ ok: true, received: n, persisted: n, duplicates: 0, pruned: 0, rejected: 0 }),
      { status: 200 }
    );
  };
  const logs = [];
  try {
    const ack = await postUsageBatches({
      events,
      ingestUrl: "http://localhost/ingest",
      ingestToken: "t",
      producerId: "test",
      log: (m) => logs.push(m),
    });
    assert(ack.received === 7 && ack.persisted === 6 && ack.conflicted === 1 && ack.rejected === 0,
      `conflict isolation ack ${JSON.stringify(ack)}`);
    assert(logs.some((m) => m.includes(poisonId)), "skipped conflicting eventId is logged");
  } finally {
    globalThis.fetch = realFetch;
  }
  // A non-conflict 4xx must still fail the run, with the server message attached.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad token" } }), { status: 401 });
  try {
    let message = "";
    try {
      await postUsageBatches({ events, ingestUrl: "http://localhost/ingest", ingestToken: "t", producerId: "test", log: () => {} });
    } catch (e) {
      message = e.message;
    }
    assert(message.includes("HTTP 401") && message.includes("bad token"), `4xx keeps failing loudly: ${message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("ok session-token-collectors");
