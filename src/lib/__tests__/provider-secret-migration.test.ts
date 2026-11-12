import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

const ENCRYPTION_KEY = "31".repeat(32);
let directory: string;
let databaseUrl: string;
let prisma: typeof import("@/lib/prisma").prisma;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let decryptJson: typeof import("@/lib/crypto").decryptJson;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-secret-migration-"));
  const dbPath = path.join(directory, "test.db");
  databaseUrl = `file:${dbPath}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ encryptJson, decryptJson } = await import("@/lib/crypto"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  delete process.env.ENCRYPTION_KEY;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe("provider secret migration", () => {
  it("preserves newer encrypted credentials, moves legacy secrets, scrubs browser state, and is idempotent", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "legacy-browser-sync",
        displayName: "Legacy browser sync",
        type: "builtin",
        config: {
          accountId: "safe-account",
          apiSecret: "stale-plaintext-secret",
          managementKey: "legacy-management-key",
          sessionCookie: "session=remove-me",
          localStorage: { access: "remove-me-too" },
        },
        secretConfig: encryptJson({
          apiSecret: "newer-encrypted-secret",
          sessionStorage: { session: "remove-encrypted-state" },
        }),
      },
    });

    const runMigration = () =>
      execFileSync(
        process.execPath,
        ["scripts/migrate-provider-config-secrets.mjs", "--apply"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            ENCRYPTION_KEY,
          },
          encoding: "utf8",
        }
      );

    const output = runMigration();
    expect(output).not.toContain("stale-plaintext-secret");
    expect(output).not.toContain("newer-encrypted-secret");
    expect(output).not.toContain("remove-me");

    const migrated = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(migrated.config).toEqual({ accountId: "safe-account" });
    expect(decryptJson(migrated.secretConfig!)).toEqual({
      apiSecret: "newer-encrypted-secret",
      managementKey: "legacy-management-key",
    });
    const firstCiphertext = migrated.secretConfig;

    const secondOutput = runMigration();
    const afterSecondRun = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(secondOutput).toContain("0 migrated");
    expect(afterSecondRun.config).toEqual(migrated.config);
    expect(afterSecondRun.secretConfig).toBe(firstCiphertext);
  });
});
