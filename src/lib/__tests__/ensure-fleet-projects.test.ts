import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { canonicalProjectKey } from "../provider-identity";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let ensureFleetProjectsSeeded: typeof import("../ensure-fleet-projects").ensureFleetProjectsSeeded;
let FLEET_PROJECT_SEEDS: typeof import("../ensure-fleet-projects").FLEET_PROJECT_SEEDS;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-projects-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "42".repeat(32);
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ ensureFleetProjectsSeeded, FLEET_PROJECT_SEEDS } = await import(
    "../ensure-fleet-projects"
  ));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.project.deleteMany();
});

describe("ensureFleetProjectsSeeded", () => {
  it("creates one project per fleet app", async () => {
    const first = await ensureFleetProjectsSeeded();
    expect(first.created).toBe(FLEET_PROJECT_SEEDS.length);
    expect(first.existing).toBe(0);
    const names = new Set(first.names);
    expect(names.has("Socratic.Trade")).toBe(true);
    expect(names.has("Congress.Trade")).toBe(true);
    expect(names.has("Usage Monitor")).toBe(true);
    expect(names.has("DealDex")).toBe(true);
    expect(names.has("Personal-Site")).toBe(true);
    expect(names.has("Autorotate")).toBe(true);
    expect(names.has("ContactLogo")).toBe(true);
    expect(names.has("Fleet")).toBe(true);

    const second = await ensureFleetProjectsSeeded();
    expect(second.created).toBe(0);
    expect(second.existing).toBe(FLEET_PROJECT_SEEDS.length);
  });

  it("does not duplicate SocraticTrade.com as Socratic.Trade", async () => {
    await prisma.project.create({
      data: {
        name: "SocraticTrade.com",
        nameKey: canonicalProjectKey("SocraticTrade.com"),
      },
    });
    const result = await ensureFleetProjectsSeeded();
    const socratic = await prisma.project.findMany({
      where: { nameKey: canonicalProjectKey("Socratic.Trade") },
    });
    expect(socratic).toHaveLength(1);
    expect(socratic[0].name).toBe("SocraticTrade.com");
    expect(result.names).toContain("SocraticTrade.com");
    expect(result.names).not.toContain("Socratic.Trade");
  });
});
