import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("../prisma").prisma;
let purgeAgentTurns: typeof import("../data-retention").purgeAgentTurns;

const NOW = new Date("2026-10-11T12:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-turn-retention-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.AGENT_TURN_RETENTION_DAYS = "90";
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("../prisma"));
  ({ purgeAgentTurns } = await import("../data-retention"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.agentTurn.deleteMany();
});

describe("purgeAgentTurns", () => {
  it("clears expired prompt/response and deletes rows past retention", async () => {
    await prisma.agentTurn.createMany({
      data: [
        {
          platform: "cursor-agent",
          promptText: "keep-content",
          responseText: "keep-content",
          occurredAt: new Date("2026-10-01T00:00:00.000Z"),
          contentExpiresAt: new Date("2026-11-01T00:00:00.000Z"),
        },
        {
          platform: "cursor-agent",
          promptText: "expired-prompt",
          responseText: "expired-response",
          occurredAt: new Date("2026-09-20T00:00:00.000Z"),
          contentExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          platform: "cursor-agent",
          promptText: "old-row",
          occurredAt: new Date("2026-06-01T00:00:00.000Z"),
          contentExpiresAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await purgeAgentTurns(NOW);
    expect(result.contentCleared).toBeGreaterThanOrEqual(1);
    expect(result.rowsDeleted).toBe(1);

    const remaining = await prisma.agentTurn.findMany({ orderBy: { occurredAt: "desc" } });
    expect(remaining).toHaveLength(2);
    const stillFresh = remaining.find((row) => row.promptText === "keep-content");
    expect(stillFresh).toBeDefined();
    const cleared = remaining.find((row) => row.occurredAt.toISOString().startsWith("2026-09-20"));
    expect(cleared?.promptText).toBeNull();
    expect(cleared?.responseText).toBeNull();
  });
});
