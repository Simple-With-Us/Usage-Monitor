import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Standalone maintenance modules are plain ESM for direct Node execution; `allowJs`
// resolves them without type declarations.
import {
  decryptEnvelope,
  encryptPayload,
  EXCLUDED_PROVIDERS,
  PROVIDER_SOURCES,
} from "../../../scripts/local-keys-bundle.mjs";

const SCRIPT_PATH = path.resolve(__dirname, "../../../scripts/local-keys-bundle.mjs");

// ---------------------------------------------------------------------------
// PINNED CROSS-LANGUAGE TEST VECTOR — embedded verbatim on both lanes (this
// vitest suite and the Swift importer tests) so the implementations can never
// drift.  Fixture iterations are 210000; the production default is 600000.
// ---------------------------------------------------------------------------
const PINNED_PASSPHRASE = "correct-horse-test-vector";
const PINNED_ENVELOPE_JSON =
  '{"format":"usage-monitor-local-keys","formatVersion":1,"kdf":"pbkdf2-hmac-sha256","iterations":210000,"salt":"dW0tbG9jYWwta2V5cy1maQ==","nonce":"Zml4dHVyZS1ub25j","ciphertext":"TOCQha75BDgHZXvA9wePn4oooAuBloZFcB/gXEorUslZfJEiLSZFZl03cGqtZOi+AnKP0RWmUT3TcFiJc0q/ub+flH/WyAl0k/MAI2UO1P1D1v7O0HplHiIOYWuorpYFwu8quG//VYrIHFzpZHInPUuS0zsOuMWg0c9xNEHLh6gPmu2PdurIMK+m09gJmmwLYauVGOqo+M1IfnXPdi1XjADqDxDuJqQ6wpbl+NREr69b3akWnPUE1KP/iEdm/AYguQtUxNQdrVK1lNfnJm5cl13PvAeeodTJx5UiuFVKVxhUZ3re+FnszcI4h6uY1CGm9C/SQ1+1XrAADAKm8KTJu3X4e09ADNKp0Q=="}';
const PINNED_PAYLOAD_JSON =
  '{"format":"usage-monitor-local-keys-payload","formatVersion":1,"createdAt":"2026-08-12T00:00:00.000Z","secrets":[{"provider":"openrouter","apiKey":"sk-or-fixture-not-real"},{"provider":"xai","apiKey":"xai-fixture-not-real","teamId":"team-fixture"}]}';

// Obviously-fake fixture values for the round-trip secrets file.  Never use
// realistic vendor key shapes here; gitleaks and push protection scan this repo.
const FAKE_OPENROUTER = "fixture-openrouter-value-not-a-key";
const FAKE_XAI = "fixture-xai-value-not-a-key";
const FAKE_XAI_TEAM = "fixture-team-id";
const FAKE_B2_KEY_ID = "fixture-b2-key-id";
const FAKE_B2_APP_KEY = "fixture-b2-app-value";
const FAKE_VALUES = [FAKE_OPENROUTER, FAKE_XAI, FAKE_B2_KEY_ID, FAKE_B2_APP_KEY];

const ROUND_TRIP_PASSPHRASE = "fixture-bundle-passphrase";
// Minimum allowed by the contract; keeps PBKDF2 cheap in CI.
const TEST_ITERATIONS = 100000;

let tempDirectory: string;
let passphraseFile: string;
let secretsFile: string;

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function expectNoSecretValues(text: string) {
  for (const value of FAKE_VALUES) {
    expect(text).not.toContain(value);
  }
}

beforeAll(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-keys-bundle-test-"));
  passphraseFile = path.join(tempDirectory, "passphrase.txt");
  fs.writeFileSync(passphraseFile, `${ROUND_TRIP_PASSPHRASE}\n`, { mode: 0o600 });
  secretsFile = path.join(tempDirectory, "fixture-secrets");
  fs.writeFileSync(
    secretsFile,
    [
      `OPENROUTER_ADMIN_KEY="${FAKE_OPENROUTER}"`,
      `XAI_MANAGEMENT_KEY="${FAKE_XAI}"`,
      `XAI_TEAM_ID="${FAKE_XAI_TEAM}"`,
      `BACKBLAZE_MASTER_KEY_ID="${FAKE_B2_KEY_ID}"`,
      `BACKBLAZE_MASTER_APPLICATION_KEY="${FAKE_B2_APP_KEY}"`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
});

afterAll(() => {
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe("local-keys-bundle pinned vector", () => {
  it("decrypts the pinned envelope to exactly the pinned payload", () => {
    const payload = decryptEnvelope(JSON.parse(PINNED_ENVELOPE_JSON), PINNED_PASSPHRASE);
    expect(payload).toEqual(JSON.parse(PINNED_PAYLOAD_JSON));
  });

  it("round-trips the pinned payload through the script's own encryptor", () => {
    const payload = JSON.parse(PINNED_PAYLOAD_JSON);
    const envelope = encryptPayload(payload, PINNED_PASSPHRASE, { iterations: 210000 });
    expect(decryptEnvelope(envelope, PINNED_PASSPHRASE)).toEqual(payload);
  });
});

describe("local-keys-bundle CLI round-trip", () => {
  it("builds, verifies, and never prints a secret value", () => {
    const outPath = path.join(tempDirectory, "round-trip.umkeys");

    const listResult = runCli(["list", "--secrets-file", secretsFile]);
    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain("openrouter");
    expect(listResult.stdout).toContain("OPENROUTER_ADMIN_KEY");
    expect(listResult.stdout).toContain("Present");
    expect(listResult.stdout).toContain("Absent");
    expect(listResult.stdout).toContain("twilio");
    expectNoSecretValues(listResult.combined);

    const buildResult = runCli([
      "build",
      "--passphrase-file",
      passphraseFile,
      "--out",
      outPath,
      "--secrets-file",
      secretsFile,
      "--iterations",
      String(TEST_ITERATIONS),
    ]);
    expect(buildResult.status).toBe(0);
    expect(buildResult.stdout).toContain("openrouter");
    expect(buildResult.stdout).toContain("xai");
    expect(buildResult.stdout).toContain("backblaze");
    expect(buildResult.stdout).toContain("Skipped: openai");
    expectNoSecretValues(buildResult.combined);

    const verifyResult = runCli(["verify", "--passphrase-file", passphraseFile, outPath]);
    expect(verifyResult.status).toBe(0);
    expect(verifyResult.stdout).toContain("usage-monitor-local-keys-payload v1");
    expect(verifyResult.stdout).toContain("Providers (3): openrouter, xai, backblaze");
    expect(verifyResult.stdout).toContain("Config section embedded: no");
    expectNoSecretValues(verifyResult.combined);

    // The written envelope itself must be ciphertext only — no plaintext values.
    const envelopeText = fs.readFileSync(outPath, "utf8");
    expectNoSecretValues(envelopeText);

    // Decrypt in-process and check the mapped fields made it through intact.
    const payload = decryptEnvelope(JSON.parse(envelopeText), ROUND_TRIP_PASSPHRASE);
    const byProvider = new Map(
      (payload.secrets as Array<Record<string, string>>).map((secret) => [
        secret.provider,
        secret,
      ])
    );
    expect([...byProvider.keys()].sort()).toEqual(["backblaze", "openrouter", "xai"]);
    expect(byProvider.get("openrouter")?.apiKey).toBe(FAKE_OPENROUTER);
    expect(byProvider.get("xai")?.apiKey).toBe(FAKE_XAI);
    expect(byProvider.get("xai")?.teamId).toBe(FAKE_XAI_TEAM);
    expect(byProvider.get("backblaze")?.apiKey).toBe(`${FAKE_B2_KEY_ID}:${FAKE_B2_APP_KEY}`);
  });

  it("rejects a wrong passphrase cleanly and leaves no partial output behind", () => {
    const outPath = path.join(tempDirectory, "wrong-pass.umkeys");
    const buildResult = runCli([
      "build",
      "--passphrase-file",
      passphraseFile,
      "--out",
      outPath,
      "--secrets-file",
      secretsFile,
      "--providers",
      "openrouter",
      "--iterations",
      String(TEST_ITERATIONS),
    ]);
    expect(buildResult.status).toBe(0);

    const wrongPassphraseFile = path.join(tempDirectory, "wrong-passphrase.txt");
    fs.writeFileSync(wrongPassphraseFile, "fixture-wrong-passphrase\n", { mode: 0o600 });
    const verifyResult = runCli(["verify", "--passphrase-file", wrongPassphraseFile, outPath]);
    expect(verifyResult.status).toBe(1);
    expect(verifyResult.stderr).toContain("Decryption failed");
    expectNoSecretValues(verifyResult.combined);

    // A failing build (invalid --config) must not leave a partial bundle behind.
    const badConfigPath = path.join(tempDirectory, "bad-config.json");
    fs.writeFileSync(badConfigPath, "{not json");
    const failedOutPath = path.join(tempDirectory, "never-written.umkeys");
    const failedBuild = runCli([
      "build",
      "--passphrase-file",
      passphraseFile,
      "--out",
      failedOutPath,
      "--secrets-file",
      secretsFile,
      "--config",
      badConfigPath,
      "--iterations",
      String(TEST_ITERATIONS),
    ]);
    expect(failedBuild.status).toBe(1);
    expect(fs.existsSync(failedOutPath)).toBe(false);
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects an envelope whose stored iterations are too weak", () => {
    const weakEnvelope = {
      ...(JSON.parse(PINNED_ENVELOPE_JSON) as Record<string, unknown>),
      iterations: 50000,
    };
    expect(() => decryptEnvelope(weakEnvelope, PINNED_PASSPHRASE)).toThrow(/minimum/);

    const weakPath = path.join(tempDirectory, "weak.umkeys");
    fs.writeFileSync(weakPath, JSON.stringify(weakEnvelope));
    const pinnedPassphraseFile = path.join(tempDirectory, "pinned-passphrase.txt");
    fs.writeFileSync(pinnedPassphraseFile, `${PINNED_PASSPHRASE}\n`, { mode: 0o600 });
    const verifyResult = runCli(["verify", "--passphrase-file", pinnedPassphraseFile, weakPath]);
    expect(verifyResult.status).toBe(1);
    expect(verifyResult.stderr).toContain("below the minimum");
  });

  it("refuses a group- or world-readable passphrase file", () => {
    const openPassphraseFile = path.join(tempDirectory, "open-passphrase.txt");
    fs.writeFileSync(openPassphraseFile, "fixture-open-passphrase\n", { mode: 0o644 });
    fs.chmodSync(openPassphraseFile, 0o644);
    const outPath = path.join(tempDirectory, "refused.umkeys");
    const buildResult = runCli([
      "build",
      "--passphrase-file",
      openPassphraseFile,
      "--out",
      outPath,
      "--secrets-file",
      secretsFile,
      "--iterations",
      String(TEST_ITERATIONS),
    ]);
    expect(buildResult.status).toBe(1);
    expect(buildResult.stderr).toContain("group- or world-readable");
    expect(fs.existsSync(outPath)).toBe(false);
  });
});

describe("local-keys-bundle mapping table", () => {
  it("covers every phone-pollable catalog provider exactly once", () => {
    // Keep in sync with LocalProviderCatalogEntry.phonePollAdapterKinds for
    // entries whose catalog mode is .poll (the only ones that can take a key
    // on the phone).  Twilio is intentionally excluded until a clean
    // SID + token pair exists in the secrets file.
    const mapped = PROVIDER_SOURCES.map((source: { provider: string }) => source.provider);
    const excluded = EXCLUDED_PROVIDERS.map((entry: { provider: string }) => entry.provider);
    expect([...mapped, ...excluded].sort()).toEqual(
      [
        "anthropic",
        "apify",
        "backblaze",
        "deepseek",
        "firecrawl",
        "hetzner",
        "openai",
        "openrouter",
        "pushover",
        "resend",
        "stripe",
        "twelvedata",
        "twilio",
        "xai",
      ].sort()
    );
    expect(new Set(mapped).size).toBe(mapped.length);
  });
});
