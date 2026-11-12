import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let directory: string;
let databaseUrl: string;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-link-index-"));
  const dbPath = path.join(directory, "test.db");
  databaseUrl = `file:${dbPath}`;
  process.env.DATABASE_URL = databaseUrl;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function runScript(script: string, url = databaseUrl) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
}

function sanitizeScriptDiagnostic(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
  return text
    .replaceAll(databaseUrl, "file:<test-db>")
    .replaceAll(directory, "<test-dir>")
    .replaceAll(process.cwd(), "<repo>")
    .slice(0, 2_000);
}

function expectScriptSuccess(
  label: string,
  result: ReturnType<typeof runScript>
): void {
  const diagnostics = JSON.stringify({
    error: sanitizeScriptDiagnostic(result.error),
    signal: result.signal ?? "",
    stdout: sanitizeScriptDiagnostic(result.stdout),
    stderr: sanitizeScriptDiagnostic(result.stderr),
  });
  expect(result.status, `${label} failed: ${diagnostics}`).toBe(0);
}

describe("subscription billing link startup constraint", () => {
  it("allows an existing pre-Subscription database to reach the additive migration", () => {
    const legacyPath = path.join(directory, "legacy.db");
    fs.writeFileSync(legacyPath, "");
    const legacyUrl = `file:${legacyPath}`;

    const audit = runScript("scripts/audit-subscription-links.mjs", legacyUrl);
    const ensure = runScript(
      "scripts/ensure-subscription-link-unique-index.mjs",
      legacyUrl
    );

    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain("migration will create them");
    expect(ensure.status).toBe(0);
    expect(ensure.stdout).toContain("migration will create them");
  });

  it("blocks duplicate legacy data, then installs the exact unique index after repair", async () => {
    await prisma.$executeRawUnsafe(
      'DROP INDEX "Subscription_providerId_externalBillingSource_externalBillingId_key"'
    );
    const provider = await prisma.provider.create({
      data: { name: "cloudflare", displayName: "Cloudflare", type: "builtin" },
    });
    const subscriptionData = {
      providerId: provider.id,
      externalBillingSource: "cloudflare-subscriptions",
      externalBillingId: "workers",
      costUsd: 5,
      startDate: new Date("2026-07-01T00:00:00Z"),
      currentPeriodStart: new Date("2026-07-01T00:00:00Z"),
      nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
    };
    const first = await prisma.subscription.create({
      data: { ...subscriptionData, name: "First" },
    });
    const duplicate = await prisma.subscription.create({
      data: { ...subscriptionData, name: "Duplicate" },
    });

    // These scripts run before the application opens its long-lived Prisma
    // client in production. Close the fixture client before simulating each
    // startup so its SQLite connection cannot intermittently block child DDL.
    await prisma.$disconnect();
    const blocked = runScript("scripts/audit-subscription-links.mjs");
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("duplicate provider billing identity");

    await prisma.subscription.delete({ where: { id: duplicate.id } });
    await prisma.$disconnect();
    const repairedAudit = runScript("scripts/audit-subscription-links.mjs");
    expectScriptSuccess("subscription-link audit", repairedAudit);
    const ensured = runScript("scripts/ensure-subscription-link-unique-index.mjs");
    expectScriptSuccess("subscription-link index installer", ensured);

    await expect(
      prisma.subscription.create({
        data: { ...subscriptionData, name: "Rejected after index" },
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.subscription.findUnique({ where: { id: first.id } })).not.toBeNull();
  });
});
