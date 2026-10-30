import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadHubSnapshot, hubBootstrapPlan } from "./telemetry-hub/snapshot-config.mjs";

const run = promisify(execFile);
const bootstrap = fileURLToPath(new URL("./telemetry-hub/start-with-infisical.mjs", import.meta.url));
test("container bootstrap fails closed without its scoped service token", async () => {
  await assert.rejects(run(process.execPath, [bootstrap], { env: { ...process.env, INFISICAL_TOKEN: "", INFISICAL_PROJECT_ID: "" } }), (error) => error.code === 2 && error.stderr.includes("scoped Infisical service token"));
});

test("bootstrap scopes prod telemetry folder, excludes imports and keeps bearer out of argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-bootstrap-"));
  try {
    await writeFile(join(root, "infisical"), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),hasToken:!!process.env.INFISICAL_TOKEN}));\n`, { mode: 0o700 });
    const secret = "TEST_ONLY_NOT_A_REAL_SERVICE_TOKEN";
    const { stdout } = await run(process.execPath, [bootstrap], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, INFISICAL_TOKEN: secret, INFISICAL_PROJECT_ID: "00000000-0000-0000-0000-000000000000" }, timeout: 15000 });
    const result = JSON.parse(stdout);
    assert.equal(result.hasToken, true);
    assert.ok(!stdout.includes(secret));
    assert.deepEqual(result.args, ["run", "--silent", "--telemetry=false", "--env", "prod", "--path", "/telemetry", "--include-imports=false", "--recursive=false", "--expand=false", "--projectId", "00000000-0000-0000-0000-000000000000", "--", "node", "scripts/telemetry-hub/launch-server.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const snapshot = {
  SENTRY_OTLP_ENDPOINT: "https://example.sentry.io/api/1/integration/otlp",
  SENTRY_PUBLIC_KEY: "abc123",
  TELEMETRY_HUB_SOURCES_JSON: JSON.stringify([{ id: "test-source", platform: "claude-code", token: "test-only-bearer-000000000000000000000000" }]),
};

async function snapshotFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "hub-snapshot-"));
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
  try { await fn(path, root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("explicit secure snapshot overrides ambient values and strips machine identities", () => snapshotFixture(async (path) => {
  assert.deepEqual(await loadHubSnapshot(path), snapshot);
  const plan = await hubBootstrapPlan({ TELEMETRY_HUB_CONFIG_FILE: path, SENTRY_PUBLIC_KEY: "ambient-wrong-value", INFISICAL_AUTOMATION_CLIENT_ID: "wrong-identity", INFISICAL_AUTOMATION_CLIENT_SECRET: "wrong-secret" });
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.env.SENTRY_PUBLIC_KEY, snapshot.SENTRY_PUBLIC_KEY);
  assert.ok(!plan.env.INFISICAL_AUTOMATION_CLIENT_ID);
  assert.ok(!plan.env.INFISICAL_AUTOMATION_CLIENT_SECRET);
  assert.ok(!plan.env.INFISICAL_TOKEN);
  assert.deepEqual(plan.args, ["scripts/telemetry-hub/launch-server.mjs"]);
}));

test("snapshot rejects permissive modes, symlinks, directories and missing files", () => snapshotFixture(async (path, root) => {
  for (const mode of [0o644, 0o640, 0o400, 0o1600]) {
    await chmod(path, mode);
    await assert.rejects(loadHubSnapshot(path), /missing, insecure or invalid/);
  }
  await chmod(path, 0o600);
  const link = join(root, "link.json");
  await symlink(path, link);
  await assert.rejects(loadHubSnapshot(link), /missing, insecure or invalid/);
  await assert.rejects(loadHubSnapshot(root), /missing, insecure or invalid/);
  await assert.rejects(loadHubSnapshot(join(root, "missing")), /missing, insecure or invalid/);
}));

test("snapshot rejects malformed, unknown, missing, wrongly typed or unsafe fields without echo", () => snapshotFixture(async (path) => {
  const cases = ["PRIVATE_MALFORMED_CONTENT", JSON.stringify({ ...snapshot, SECRET: "PRIVATE_CONTENT" }), JSON.stringify({ SENTRY_PUBLIC_KEY: "abc" }), JSON.stringify({ ...snapshot, SENTRY_PUBLIC_KEY: 42 }), JSON.stringify({ ...snapshot, SENTRY_OTLP_ENDPOINT: "http://unsafe.example/api/1/integration/otlp" }), JSON.stringify({ ...snapshot, TELEMETRY_HUB_SOURCES_JSON: "PRIVATE_MALFORMED_CONTENT" })];
  for (const text of cases) {
    await writeFile(path, text);
    await assert.rejects(loadHubSnapshot(path), (error) => error.message === "Hub snapshot is missing, insecure or invalid");
  }
}));

test("bootstrap modes cannot silently fallback when a token and snapshot are both set", () => snapshotFixture(async (path) => {
  await assert.rejects(hubBootstrapPlan({ INFISICAL_TOKEN: "intended-token", TELEMETRY_HUB_CONFIG_FILE: path }), /mutually exclusive/);
  const plan = await hubBootstrapPlan({ INFISICAL_TOKEN: "intended-token", INFISICAL_PROJECT_ID: "00000000-0000-0000-0000-000000000000" });
  assert.equal(plan.command, "infisical");
  assert.ok(!plan.env.TELEMETRY_HUB_CONFIG_FILE);
}));
