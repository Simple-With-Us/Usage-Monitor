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
  runCli as runBundleCli,
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
let trapDirectory: string;
let readerMarker: string;

function runNode(args: string[], syncedEnv: Record<string, string> = {}) {
  const childEnv: NodeJS.ProcessEnv = {
    ...syncedEnv,
    HOME: tempDirectory, PATH: trapDirectory, FIXTURE_READER_MARKER: readerMarker,
    NODE_ENV: "test", VITEST: "true",
  };
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
    env: childEnv,
  });
  if (result.error || result.signal || result.status === null) throw new Error("Bundle fixture child failed to complete");
  expect(fs.existsSync(readerMarker)).toBe(false);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function runCli(args: string[], syncedEnv: Record<string, string> = {}) {
  return runNode([SCRIPT_PATH, ...args], syncedEnv);
}

function runInProcess(args: string[], syncedEnv: Record<string, string> = {}) {
  const savedEnv = process.env;
  const savedLog = console.log;
  const lines: string[] = [];
  try {
    process.env = {
      ...syncedEnv,
      HOME: tempDirectory, PATH: trapDirectory, FIXTURE_READER_MARKER: readerMarker,
      NODE_ENV: "test", VITEST: "true",
    };
    console.log = (...data: unknown[]) => { lines.push(data.map(String).join(" ")); };
    expect(runBundleCli(args)).toBe(0);
    expect(fs.existsSync(readerMarker)).toBe(false);
    return lines.join("\n");
  } finally {
    process.env = savedEnv;
    console.log = savedLog;
  }
}

function expectNoSecretValues(text: string) {
  for (const value of FAKE_VALUES) {
    expect(text).not.toContain(value);
  }
}

beforeAll(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-keys-bundle-test-"));
  trapDirectory = path.join(tempDirectory, ".local", "bin");
  fs.mkdirSync(trapDirectory, { recursive: true });
  readerMarker = path.join(tempDirectory, "reader-invoked");
  for (const name of ["fleet-secrets", "infisical", "security"]) {
    fs.writeFileSync(path.join(trapDirectory, name), '#!/bin/sh\nprintf invoked >> "$FIXTURE_READER_MARKER"\nexit 99\n', { mode: 0o700 });
  }
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

describe("local-keys-bundle synced environment", () => {
  it("keeps isolation controls fixed in the actual child when synced fields collide", () => {
    const result = runNode(["--input-type=module", "-e", 'console.log(JSON.stringify(Object.fromEntries(["HOME", "PATH", "FIXTURE_READER_MARKER", "NODE_ENV", "VITEST"].map(name => [name, process.env[name]]))))'], {
      HOME: "fixture-home", PATH: "fixture-path", FIXTURE_READER_MARKER: "fixture-marker",
      NODE_ENV: "production", VITEST: "false",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      HOME: tempDirectory, PATH: trapDirectory, FIXTURE_READER_MARKER: readerMarker,
      NODE_ENV: "test", VITEST: "true",
    });
  });

  it("lists only catalog key presence, including empty values, without reading values", () => {
    const result = runCli(["list"], { OPENAI_ADMIN_KEY: "", UNRELATED_FIXTURE_SECRET: "fixture-unrelated-value" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Name Presence");
    expect(result.stdout).toContain("Present means the name exists; it does not verify a usable value.");
    expect(result.stdout).toMatch(/openai\s+OPENAI_ADMIN_KEY\s+Present/);
    expect(result.stdout).toMatch(/openrouter\s+OPENROUTER_ADMIN_KEY\s+Absent/);
    expect(result.combined).not.toContain("UNRELATED_FIXTURE_SECRET");
    expect(result.combined).not.toContain("fixture-unrelated-value");

    const savedEnv = process.env;
    const savedLog = console.log;
    const lines: string[] = [];
    try {
      const presenceEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", VITEST: "true" };
      process.env = Object.defineProperty(presenceEnv, "OPENAI_ADMIN_KEY", {
        enumerable: true, get() { throw new Error("list must never read a provider value"); },
      });
      console.log = (...data: unknown[]) => { lines.push(data.map(String).join(" ")); };
      expect(runBundleCli(["list"])).toBe(0);
    } finally {
      process.env = savedEnv;
      console.log = savedLog;
    }
    expect(lines.join("\n")).toMatch(/openai\s+OPENAI_ADMIN_KEY\s+Present/);
  });

  it("builds and verifies only the fixed catalog's synced values with private output", () => {
    const outPath = path.join(tempDirectory, "synced.umkeys");
    const result = runCli(["build", "--passphrase-file", passphraseFile, "--out", outPath, "--iterations", String(TEST_ITERATIONS)], {
      OPENROUTER_ADMIN_KEY: FAKE_OPENROUTER,
      OPENAI_ADMIN_KEY: "", ANTHROPIC_ADMIN_KEY: " \t ",
      XAI_MANAGEMENT_KEY: FAKE_XAI, XAI_TEAM_ID: FAKE_XAI_TEAM,
      BACKBLAZE_MASTER_KEY_ID: FAKE_B2_KEY_ID, BACKBLAZE_MASTER_APPLICATION_KEY: FAKE_B2_APP_KEY,
      UNRELATED_FIXTURE_SECRET: "fixture-unrelated-value",
      INFISICAL_TOKEN: "st.fixture-bootstrap", INFISICAL_UM_CLIENT_SECRET: "fixture-retired-value",
    });
    expect(result.status).toBe(0);
    expectNoSecretValues(result.combined);
    expect(result.combined).not.toContain("fixture-unrelated-value");
    expect(result.combined).not.toContain("fixture-retired-value");
    const descriptor = fs.openSync(outPath, "r");
    let envelopeText: string;
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      envelopeText = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    const payload = decryptEnvelope(JSON.parse(envelopeText), ROUND_TRIP_PASSPHRASE);
    expect(payload.secrets).toEqual([
      { provider: "openrouter", apiKey: FAKE_OPENROUTER },
      { provider: "xai", apiKey: FAKE_XAI, teamId: FAKE_XAI_TEAM },
      { provider: "backblaze", apiKey: `${FAKE_B2_KEY_ID}:${FAKE_B2_APP_KEY}` },
    ]);
    expect(runCli(["verify", "--passphrase-file", passphraseFile, outPath]).status).toBe(0);
  });

  it("refuses an absent or partial catalog without a reader call or partial output", () => {
    const cases: Array<Record<string, string>> = [{}, { XAI_MANAGEMENT_KEY: FAKE_XAI }, { BACKBLAZE_MASTER_KEY_ID: FAKE_B2_KEY_ID }];
    for (const [index, env] of cases.entries()) {
      const outPath = path.join(tempDirectory, `absent-${index}.umkeys`);
      const result = runCli(["build", "--passphrase-file", passphraseFile, "--out", outPath, "--iterations", String(TEST_ITERATIONS)], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No provider keys found to bundle");
      expectNoSecretValues(result.combined);
      expect(fs.existsSync(outPath)).toBe(false);
    }
    const listed = runCli(["list"], { XAI_MANAGEMENT_KEY: FAKE_XAI });
    expect(listed.stdout).toContain("Partial (XAI_MANAGEMENT_KEY is set but XAI_TEAM_ID is missing)");
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps explicit fixture-file precedence over synced values", () => {
    const outPath = path.join(tempDirectory, "fixture-precedence.umkeys");
    const result = runCli(["build", "--passphrase-file", passphraseFile, "--out", outPath, "--providers", "openrouter", "--secrets-file", secretsFile, "--iterations", String(TEST_ITERATIONS)], {
      OPENROUTER_ADMIN_KEY: "fixture-env-must-not-win",
    });
    expect(result.status).toBe(0);
    const payload = decryptEnvelope(JSON.parse(fs.readFileSync(outPath, "utf8")), ROUND_TRIP_PASSPHRASE);
    expect(payload.secrets).toEqual([{ provider: "openrouter", apiKey: FAKE_OPENROUTER }]);
  });

  for (const [label, value] of Object.entries({ empty: "", whitespace: " \t\n " })) {
    it(`refuses ${label} provider values without writing a bundle`, () => {
      const outPath = path.join(tempDirectory, `blank-${label}.umkeys`);
      const result = runCli(["build", "--passphrase-file", passphraseFile, "--out", outPath, "--iterations", String(TEST_ITERATIONS)], {
        OPENAI_ADMIN_KEY: value,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No provider keys found to bundle");
      expectNoSecretValues(result.combined);
      expect(fs.existsSync(outPath)).toBe(false);
      expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  }
});

describe("local-keys-bundle in-process CLI boundaries", () => {
  it("builds and verifies the complete synced catalog with private atomic output and config", () => {
    const syncedEnv: Record<string, string> = {};
    for (const source of PROVIDER_SOURCES) {
      if (source.apiKeyEnv) syncedEnv[source.apiKeyEnv] = FAKE_OPENROUTER;
      if (source.teamIdEnv) syncedEnv[source.teamIdEnv] = FAKE_XAI_TEAM;
      for (const name of source.compositeEnvs ?? []) syncedEnv[name] = FAKE_B2_APP_KEY;
    }
    const configPath = path.join(tempDirectory, "in-process-config.json");
    const config = { format: "usage-monitor-local-export", formatVersion: 1, providers: [] };
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const outPath = path.join(tempDirectory, "in-process.umkeys");
    const output = runInProcess(["build", "--passphrase-file", passphraseFile, "--out", outPath,
      "--config", configPath, "--iterations", String(TEST_ITERATIONS)], syncedEnv);
    expect(output).toContain(`Included providers (${PROVIDER_SOURCES.length})`);
    expectNoSecretValues(output);
    const descriptor = fs.openSync(outPath, "r");
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      const payload = decryptEnvelope(JSON.parse(fs.readFileSync(descriptor, "utf8")), ROUND_TRIP_PASSPHRASE);
      expect(payload.config).toEqual(config);
      expect(payload.secrets.map((secret: { provider: string }) => secret.provider)).toEqual(PROVIDER_SOURCES.map((source: { provider: string }) => source.provider));
    } finally {
      fs.closeSync(descriptor);
    }
    const verified = runInProcess(["verify", "--passphrase-file", passphraseFile, outPath]);
    expect(verified).toContain(`Providers (${PROVIDER_SOURCES.length})`);
    expect(verified).toContain("Config section embedded: yes");
    expectNoSecretValues(verified);
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("uses the explicit fixture source for names and selected build values", () => {
    const fixturePath = path.join(tempDirectory, "in-process-secrets");
    fs.writeFileSync(fixturePath, `# fixture\nignored line\nexport OPENROUTER_ADMIN_KEY='${FAKE_OPENROUTER}'\nXAI_MANAGEMENT_KEY=${FAKE_XAI}\nBACKBLAZE_MASTER_KEY_ID=${FAKE_B2_KEY_ID}\n`, { mode: 0o600 });
    const listed = runInProcess(["list", "--secrets-file", fixturePath]);
    expect(listed).toContain("Partial (missing BACKBLAZE_MASTER_APPLICATION_KEY)");
    expect(listed).toContain("Partial (XAI_MANAGEMENT_KEY is set but XAI_TEAM_ID is missing)");
    expectNoSecretValues(listed);
    const outPath = path.join(tempDirectory, "in-process-fixture.umkeys");
    const output = runInProcess(["build", "--passphrase-file", passphraseFile, "--out", outPath,
      "--providers", " openrouter, ", "--secrets-file", fixturePath, "--iterations", String(TEST_ITERATIONS)],
    { OPENROUTER_ADMIN_KEY: "fixture-other" });
    expectNoSecretValues(output);
    expect(decryptEnvelope(JSON.parse(fs.readFileSync(outPath, "utf8")), ROUND_TRIP_PASSPHRASE).secrets).toEqual([{ provider: "openrouter", apiKey: FAKE_OPENROUTER }]);
  });

  it("refuses absent, blank, and partial synced tuples before creating any output", () => {
    const outPath = path.join(tempDirectory, "in-process-refused.umkeys");
    const cases: Array<Record<string, string>> = [{}, { OPENAI_ADMIN_KEY: " \t " },
      { XAI_MANAGEMENT_KEY: FAKE_XAI }, { BACKBLAZE_MASTER_KEY_ID: FAKE_B2_KEY_ID }];
    for (const env of cases) {
      expect(() => runInProcess(["build", "--passphrase-file", passphraseFile, "--out", outPath], env)).toThrow(/No provider keys found/);
      expect(fs.existsSync(outPath)).toBe(false);
    }
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("removes its temporary file if the atomic rename fails", () => {
    const outPath = path.join(tempDirectory, "existing-directory");
    fs.mkdirSync(outPath);
    expect(() => runInProcess(["build", "--passphrase-file", passphraseFile, "--out", outPath,
      "--iterations", String(TEST_ITERATIONS)], { OPENROUTER_ADMIN_KEY: FAKE_OPENROUTER })).toThrow(/EISDIR|ENOTDIR/);
    expect(fs.readdirSync(outPath)).toEqual([]);
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects invalid source, config, passphrase, and CLI inputs without output", () => {
    const outPath = path.join(tempDirectory, "invalid-input.umkeys");
    const base = ["build", "--passphrase-file", passphraseFile, "--out", outPath];
    const missingPath = path.join(tempDirectory, "missing-fixture");
    const invalidConfig = path.join(tempDirectory, "invalid-config.json");
    fs.writeFileSync(invalidConfig, "{}", { mode: 0o600 });
    const emptyPassphrase = path.join(tempDirectory, "empty-passphrase");
    fs.writeFileSync(emptyPassphrase, "\n", { mode: 0o600 });
    const publicPassphrase = path.join(tempDirectory, "public-passphrase");
    fs.writeFileSync(publicPassphrase, "fixture-pass", { mode: 0o600 });
    fs.chmodSync(publicPassphrase, 0o644);
    const cases: Array<[string[], RegExp]> = [
      [[], /Usage:/], [["list", "--unknown"], /Unknown flag/], [["list", "--secrets-file"], /needs a value/],
      [["build"], /Missing required flag/], [[...base, "--providers", "twilio"], /is excluded/],
      [[...base, "--providers", "fixture"], /Unknown provider/], [[...base, "--config", missingPath], /missing or not valid JSON/],
      [[...base, "--config", invalidConfig], /complete/], [[...base, "--secrets-file", missingPath], /Cannot read secrets file/],
      [["build", "--passphrase-file", missingPath, "--out", outPath], /Cannot read passphrase/],
      [["build", "--passphrase-file", emptyPassphrase, "--out", outPath], /Passphrase file is empty/],
      [["build", "--passphrase-file", publicPassphrase, "--out", outPath], /group- or world-readable/],
      [[...base, "--iterations", "0"], /below the minimum/], [[...base, "--iterations", "999999999"], /above the maximum/],
      [[...base, "--iterations", "fixture"], /must be an integer/], [["verify", "--passphrase-file", passphraseFile], /Usage: verify/],
      [["verify", "--passphrase-file", passphraseFile, missingPath], /missing or not valid JSON/],
    ];
    for (const [args, error] of cases) {
      expect(() => runInProcess(args, { OPENROUTER_ADMIN_KEY: FAKE_OPENROUTER })).toThrow(error);
      expect(fs.existsSync(outPath)).toBe(false);
    }
    expect(fs.readdirSync(tempDirectory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
