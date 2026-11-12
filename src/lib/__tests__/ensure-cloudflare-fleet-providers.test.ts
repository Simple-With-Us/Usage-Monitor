import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { decrypt } from "../crypto";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let ensureCloudflareFleetProvidersSeeded: typeof import("../ensure-cloudflare-fleet-providers").ensureCloudflareFleetProvidersSeeded;
let resolveCloudflareFleetSlot: typeof import("../ensure-cloudflare-fleet-providers").resolveCloudflareFleetSlot;
let CLOUDFLARE_FLEET_SLOTS: typeof import("../ensure-cloudflare-fleet-providers").CLOUDFLARE_FLEET_SLOTS;
let isCloudflareFleetProviderName: typeof import("../ensure-cloudflare-fleet-providers").isCloudflareFleetProviderName;

const ENC = "42".repeat(32);

const SLOT_ENV = {
  R2_USAGE_ACCOUNT_ID: "acct-um-aaaaaaaaaaaaaaaaaaaaaaaaaaaad1b7",
  CLOUDFLARE_JAY_API_TOKEN: "ujs-own-token",
  CLOUDFLARE_ST_ACCOUNT_ID: "acct-st-bbbbbbbbbbbbbbbbbbbbbbbbbbbb2e79",
  CLOUDFLARE_ST_API_TOKEN: "st-token",
  CLOUDFLARE_CT_ACCOUNT_ID: "acct-ct-cccccccccccccccccccccccccccc1ae9",
  CLOUDFLARE_CT_API_TOKEN: "ct-token",
  CLOUDFLARE_OLD_ACCOUNT_ID: "acct-old-dddddddddddddddddddddddddddd8c73",
  CLOUDFLARE_FLEET_API_TOKEN: "fleet-token",
} as const;

function clearSlotEnv() {
  for (const key of [
    "R2_USAGE_ACCOUNT_ID",
    "CLOUDFLARE_JAY_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_JAY_API_TOKEN",
    "R2_USAGE_API_TOKEN",
    "CLOUDFLARE_FLEET_API_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ST_ACCOUNT_ID",
    "CLOUDFLARE_ST_API_TOKEN",
    "CLOUDFLARE_CT_ACCOUNT_ID",
    "CLOUDFLARE_CT_API_TOKEN",
    "CLOUDFLARE_OLD_ACCOUNT_ID",
    "CLOUDFLARE_OLD_API_TOKEN",
  ]) {
    delete process.env[key];
  }
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-fleet-seed-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = ENC;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({
    ensureCloudflareFleetProvidersSeeded,
    resolveCloudflareFleetSlot,
    CLOUDFLARE_FLEET_SLOTS,
    isCloudflareFleetProviderName,
  } = await import("../ensure-cloudflare-fleet-providers"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  clearSlotEnv();
  await prisma.provider.deleteMany();
});

describe("isCloudflareFleetProviderName", () => {
  it("matches the exact adapter name and per-account suffixes", () => {
    expect(isCloudflareFleetProviderName("cloudflare")).toBe(true);
    expect(isCloudflareFleetProviderName("cloudflare-congress")).toBe(true);
    expect(isCloudflareFleetProviderName("Cloudflare-Socratic")).toBe(true);
    expect(isCloudflareFleetProviderName("cloudflareworkers")).toBe(false);
    expect(isCloudflareFleetProviderName("openrouter")).toBe(false);
  });
});

describe("resolveCloudflareFleetSlot", () => {
  it("uses the Usage.Jays.Services token before fleet or ST/CT/Old", () => {
    process.env.CLOUDFLARE_JAY_API_TOKEN = "ujs-own-token";
    process.env.CLOUDFLARE_FLEET_API_TOKEN = "fleet-token";
    process.env.CLOUDFLARE_ST_API_TOKEN = "st-token";
    process.env.R2_USAGE_ACCOUNT_ID = "acct-um";
    const um = CLOUDFLARE_FLEET_SLOTS.find((s) => s.id === "um")!;
    expect(resolveCloudflareFleetSlot(um)).toEqual({
      accountId: "acct-um",
      apiToken: "ujs-own-token",
    });
  });

  it("falls back to the fleet token when Old has no dedicated token", () => {
    process.env.CLOUDFLARE_OLD_ACCOUNT_ID = "acct-old";
    process.env.CLOUDFLARE_FLEET_API_TOKEN = "fleet-token";
    const old = CLOUDFLARE_FLEET_SLOTS.find((s) => s.id === "old")!;
    expect(resolveCloudflareFleetSlot(old)?.apiToken).toBe("fleet-token");
  });
});

describe("ensureCloudflareFleetProvidersSeeded", () => {
  it("creates four active rows when env is complete", async () => {
    Object.assign(process.env, SLOT_ENV);
    const result = await ensureCloudflareFleetProvidersSeeded();
    expect(result).toEqual({ created: 4, updated: 0, skipped: 0 });
    const rows = await prisma.provider.findMany({ orderBy: { name: "asc" } });
    expect(rows.map((r) => r.name)).toEqual([
      "cloudflare-congress",
      "cloudflare-jay-old",
      "cloudflare-socratic",
      "cloudflare-usage-jays",
    ]);
    expect(rows.every((r) => r.isActive)).toBe(true);
    expect(rows.every((r) => r.type === "builtin")).toBe(true);
    const ujs = rows.find((r) => r.name === "cloudflare-usage-jays")!;
    expect(decrypt(ujs.apiKey!)).toBe("ujs-own-token");
    expect(ujs.config).toMatchObject({
      accountId: SLOT_ENV.R2_USAGE_ACCOUNT_ID,
      authMode: "api_token",
    });
    const old = rows.find((r) => r.name === "cloudflare-jay-old")!;
    expect(decrypt(old.apiKey!)).toBe("fleet-token");
  });

  it("does not duplicate and leaves a row the operator turned off", async () => {
    Object.assign(process.env, SLOT_ENV);
    await ensureCloudflareFleetProvidersSeeded();
    await prisma.provider.updateMany({ data: { isActive: false } });
    const second = await ensureCloudflareFleetProvidersSeeded();
    expect(second).toEqual({ created: 0, updated: 0, skipped: 4 });
    const rows = await prisma.provider.findMany();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.isActive)).toBe(false);
  });

  it("leaves a deliberately re-enabled row active across repeated seeds", async () => {
    Object.assign(process.env, SLOT_ENV);
    await ensureCloudflareFleetProvidersSeeded();
    await prisma.provider.updateMany({ data: { isActive: false } });
    await prisma.provider.updateMany({
      where: { name: "cloudflare-usage-jays" },
      data: { isActive: true },
    });
    await ensureCloudflareFleetProvidersSeeded();
    await ensureCloudflareFleetProvidersSeeded();
    const ujs = await prisma.provider.findFirst({
      where: { name: "cloudflare-usage-jays" },
    });
    const others = await prisma.provider.findMany({
      where: { NOT: { name: "cloudflare-usage-jays" } },
    });
    expect(ujs?.isActive).toBe(true);
    expect(others.every((r) => r.isActive === false)).toBe(true);
  });

  it("skips slots that lack an account id or token", async () => {
    const result = await ensureCloudflareFleetProvidersSeeded();
    expect(result).toEqual({ created: 0, updated: 0, skipped: 4 });
    expect(await prisma.provider.count()).toBe(0);
  });

  it("does not create kimi or oracle rows", async () => {
    Object.assign(process.env, SLOT_ENV);
    await ensureCloudflareFleetProvidersSeeded();
    const names = (await prisma.provider.findMany()).map((r) => r.name);
    expect(names.some((n) => /kimi|oracle|moonshot/i.test(n))).toBe(false);
  });
});
