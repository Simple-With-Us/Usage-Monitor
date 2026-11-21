// Offline checks for the per-consumer collector token bindings.
//
// The keychain is never touched:  every read goes through an injected `exec`
// stand-in for /usr/bin/security, and every value in a fixture is a sentinel
// that must never appear in an error, a log line or a returned string.
//
// Run with:  node --test scripts/collector-keychain.node-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KEYCHAIN_SERVICE,
  SECURITY_INTERACTION_NOT_ALLOWED,
  SECURITY_ITEM_NOT_FOUND,
  readKeychainServiceToken,
} from "./lib/keychain-service-token.mjs";
import { createScopedCollectorTokenResolver, readScopedServiceToken } from "./lib/scoped-collector-token.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const SENTINEL = "st.11111111-2222-3333-4444-555555555555.SENTINELSECRET.SENTINELSIGNATURE";

/** The binding every collector shares:  one project, two folders, read only. */
const PROJECT = "8dae6d03-8f12-48b2-adf3-e5c1b881c8c5";
const FOLDERS = ["/", "/global-api-keys"];

/** The eight scoped consumers and the grant each one owns. */
const SCOPED_BINDINGS = {
  "antigravity-session": ["antigravity-session-collector-read", "Antigravity statusline", "71280bb4-ab4a-48a6-8642-5cefba990a26"],
  "antigravity-usage": ["antigravity-usage-collector-read", "Antigravity CLI", "7a666e60-5d8f-44de-9b38-c43d7c1d3237"],
  claude: ["claude-usage-collector-read", "Claude usage", "7933c487-9059-430b-b251-b40783639f39"],
  grok: ["grok-usage-collector-read", "Grok", "ddab476f-f438-4574-8806-f7b76c3cc22d"],
  "minimax-runtime": ["minimax-runtime-usage-collector-read", "MiniMax runtime", "4365de43-c5e2-455e-9bd0-5269702570f4"],
  "muse-code": ["muse-code-collector-read", "Muse Code", "1b3880db-a43e-4bd1-a12c-af43670e8159"],
  opencode: ["opencode-usage-collector-read", "OpenCode", "9d03fa85-b0bd-431e-8c5f-368662c4b04d"],
  "subscription-quota": ["subscription-quota-collector-read", "Subscription quota", "dbe87c5b-0467-474e-ba21-5811bc91c35b"],
};

/** The entry point that owns each binding file. */
const ENTRY_POINTS = {
  "antigravity-session-collector.mjs": "antigravity-session",
  "antigravity-usage-collector.mjs": "antigravity-usage",
  "claude-usage-collector.mjs": "claude",
  "codex-usage-collector.mjs": "codex",
  "grok-usage-collector.mjs": "grok",
  "minimax-runtime-usage-collector.mjs": "minimax-runtime",
  "muse-code-usage-collector.mjs": "muse-code",
  "opencode-usage-collector.mjs": "opencode",
  "subscription-quota-collector.mjs": "subscription-quota",
};

/** The collectors that keep the generic shared resolver. */
const SHARED_COLLECTORS = [
  "copilot-usage-collector.mjs",
  "cursor-usage-collector.mjs",
  "deepseek-usage-collector.mjs",
  "fleet-usage-collector.mjs",
  "fx-usage-collector.mjs",
  "minimax-usage-collector.mjs",
  "muse-usage-collector.mjs",
];

function execReturning(stdout) {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, args]);
    return stdout;
  };
  exec.calls = calls;
  return exec;
}

function execFailing(status, stderr = "") {
  return () => {
    const error = new Error("security refused the read");
    error.status = status;
    error.stderr = stderr;
    throw error;
  };
}

function tokenFor(grantId) {
  return `st.${grantId}.SECRETSECRET.SIGNATUREPART`;
}

function serviceTokenMetadata(grantId, overrides = {}) {
  return {
    workspace: PROJECT,
    name: "claude-usage-collector-read",
    _id: grantId,
    id: grantId,
    scopes: [
      { environment: "prod", secretPath: "/global-api-keys" },
      { environment: "prod", secretPath: "/" },
    ],
    permissions: ["read"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

test("the keychain read names the fleet service and the token's own account", () => {
  const exec = execReturning(`${SENTINEL}\n`);
  const result = readKeychainServiceToken("claude-usage-collector-read", { exec });
  assert.equal(result.status, "ok");
  assert.equal(result.token, SENTINEL);
  assert.equal(exec.calls.length, 1);
  const [bin, args] = exec.calls[0];
  assert.equal(bin, "/usr/bin/security");
  assert.deepEqual(args, [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    "claude-usage-collector-read",
    "-w",
  ]);
});

test("a missing item, a locked keychain and an unreadable item are told apart", () => {
  assert.equal(readKeychainServiceToken("x", { exec: execFailing(SECURITY_ITEM_NOT_FOUND) }).status, "no-token");
  assert.equal(
    readKeychainServiceToken("x", { exec: execFailing(SECURITY_INTERACTION_NOT_ALLOWED) }).status,
    "keychain-locked",
  );
  assert.equal(readKeychainServiceToken("x", { exec: execFailing(51) }).status, "token-unreadable");
  assert.equal(readKeychainServiceToken("x", { exec: execFailing(1, "could not be found") }).status, "no-token");
});

test("an invalid account never reaches security", () => {
  const exec = execReturning(SENTINEL);
  for (const account of ["", "--help", "has space", "x".repeat(200)]) {
    const result = readKeychainServiceToken(account, { exec });
    assert.equal(result.status, "no-token");
    assert.equal(result.token, "");
  }
  assert.equal(exec.calls.length, 0, "an invalid account must not reach security");
});

test("a scoped token is read from the keychain and checked against its grant", () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  const seen = [];
  const token = readScopedServiceToken(binding, {
    readKeychain: (account) => {
      seen.push(account);
      return { token: tokenFor(grantId), status: "ok" };
    },
  });
  assert.deepEqual(seen, ["claude-usage-collector-read"]);
  assert.equal(token, `st.${grantId}.SECRETSECRET`, "the signature segment is dropped");
});

test("a token belonging to another grant, or a malformed one, is refused", () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  assert.throws(
    () =>
      readScopedServiceToken(binding, {
        readKeychain: () => ({ token: tokenFor("00000000-0000-0000-0000-000000000000"), status: "ok" }),
      }),
    /not the bound grant/,
  );
  assert.throws(
    () => readScopedServiceToken(binding, { readKeychain: () => ({ token: "not-a-service-token", status: "ok" }) }),
    /malformed/,
  );
});

test("a keychain refusal fails closed and names the reason, never the value", () => {
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId: "7933c487-9059-430b-b251-b40783639f39",
    project: PROJECT,
    folders: FOLDERS,
  };
  assert.throws(
    () => readScopedServiceToken(binding, { readKeychain: () => ({ token: "", status: "keychain-locked" }) }),
    /keychain-locked/,
  );
});

test("the resolver prefers the environment and never reads the keychain for it", async () => {
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId: "7933c487-9059-430b-b251-b40783639f39",
    project: PROJECT,
    folders: FOLDERS,
  };
  let reads = 0;
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => {
      reads += 1;
      return { token: "", status: "no-token" };
    },
  });
  const token = await resolve(["CLAUDE_INGEST_TOKEN"], { env: { CLAUDE_INGEST_TOKEN: "from-env" } });
  assert.equal(token, "from-env");
  assert.equal(reads, 0);
});

test("the resolver reads its own keychain account when the environment is empty", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  const seen = [];
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: (account) => {
      seen.push(account);
      return { token: tokenFor(grantId), status: "ok" };
    },
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(serviceTokenMetadata(grantId)));
      }
      return new Response(
        JSON.stringify({ secrets: [{ secretKey: "CLAUDE_INGEST_TOKEN", secretValue: "from-infisical" }] }),
      );
    },
  });
  const token = await resolve(["CLAUDE_INGEST_TOKEN"], { env: {} });
  assert.equal(token, "from-infisical");
  assert.deepEqual(seen, ["claude-usage-collector-read"]);
});

test("a grant that does not match its binding is refused before any secret is read", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => ({ token: tokenFor(grantId), status: "ok" }),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(
          JSON.stringify(serviceTokenMetadata(grantId, { _id: "00000000-0000-0000-0000-000000000000", id: "00000000-0000-0000-0000-000000000000" })),
        );
      }
      throw new Error("a secret read must not happen when the binding does not match");
    },
  });
  await assert.rejects(() => resolve(["CLAUDE_INGEST_TOKEN"], { env: {} }), /does not match its binding/);
});

test("a malformed Infisical response is refused whole, not read field by field", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  // The metadata body carries a shape the schema does not allow:  scopes is
  // not a list of scope objects.
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => ({ token: tokenFor(grantId), status: "ok" }),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify({ ...serviceTokenMetadata(grantId), scopes: "prod:/" }));
      }
      throw new Error("a secret read must not happen when the metadata body is malformed");
    },
  });
  await assert.rejects(() => resolve(["CLAUDE_INGEST_TOKEN"], { env: {} }), /Infisical response is invalid/);
});

test("a secret body with a malformed row is refused", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => ({ token: tokenFor(grantId), status: "ok" }),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(serviceTokenMetadata(grantId)));
      }
      return new Response(JSON.stringify({ secrets: [{ secretKey: "CLAUDE_INGEST_TOKEN" }] }));
    },
  });
  await assert.rejects(() => resolve(["CLAUDE_INGEST_TOKEN"], { env: {} }), /secret response is invalid/);
});

test("a binding that lists its folders in another order is the same grant", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: ["/global-api-keys", "/"],
  };
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => ({ token: tokenFor(grantId), status: "ok" }),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(serviceTokenMetadata(grantId)));
      }
      return new Response(
        JSON.stringify({ secrets: [{ secretKey: "CLAUDE_INGEST_TOKEN", secretValue: "from-infisical" }] }),
      );
    },
  });
  assert.equal(await resolve(["CLAUDE_INGEST_TOKEN"], { env: {} }), "from-infisical");
});

test("strict injected secrets means the environment only, and no keychain read", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  let reads = 0;
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => {
      reads += 1;
      return { token: tokenFor(grantId), status: "ok" };
    },
    fetchImpl: async () => {
      throw new Error("strict mode must not reach Infisical");
    },
  });
  const strictEnv = { COLLECTOR_STRICT_INJECTED_SECRETS: "1" };
  assert.equal(await resolve(["CLAUDE_INGEST_TOKEN"], { env: strictEnv }), null);
  assert.equal(reads, 0);
  assert.equal(
    await resolve(["CLAUDE_INGEST_TOKEN"], { env: { ...strictEnv, CLAUDE_INGEST_TOKEN: "from-env" } }),
    "from-env",
  );
  assert.equal(reads, 0);
});

test("one resolver reads the keychain once for every name it is asked for", async () => {
  const grantId = "7933c487-9059-430b-b251-b40783639f39";
  const binding = {
    account: "claude-usage-collector-read",
    label: "Claude usage",
    grantId,
    project: PROJECT,
    folders: FOLDERS,
  };
  let reads = 0;
  let metadataRequests = 0;
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: () => {
      reads += 1;
      return { token: tokenFor(grantId), status: "ok" };
    },
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/api/v2/service-token") {
        metadataRequests += 1;
        return new Response(JSON.stringify(serviceTokenMetadata(grantId)));
      }
      return new Response(
        JSON.stringify({
          secrets: [
            { secretKey: "CLAUDE_INGEST_TOKEN", secretValue: "one" },
            { secretKey: "MUSE_CODE_INGEST_TOKEN", secretValue: "two" },
          ],
        }),
      );
    },
  });
  assert.equal(await resolve(["CLAUDE_INGEST_TOKEN"], { env: {} }), "one");
  assert.equal(await resolve(["MUSE_CODE_INGEST_TOKEN"], { env: {} }), "two");
  assert.equal(reads, 1, "the keychain is read once per resolver");
  assert.equal(metadataRequests, 1, "the metadata is fetched once per resolver");
});

for (const [stem, [account, label, grantId]] of Object.entries(SCOPED_BINDINGS)) {
  test(`the ${stem} binding names its own grant and pins it`, async () => {
    const binding = await import(`./lib/${stem}-run-session-token-collector.mjs`);
    assert.deepEqual(binding.collectorTokenBinding, {
      account,
      label,
      grantId,
      project: PROJECT,
      folders: FOLDERS,
    });
    const shared = await import("./lib/run-session-token-collector.mjs");
    assert.notEqual(
      binding.resolveCollectorToken,
      shared.resolveCollectorToken,
      "the binding must override the shared resolver",
    );
    assert.equal(typeof binding.resolveCollectorToken, "function");
    // The shared surface the entry points import is still exported.
    assert.equal(typeof binding.walkFiles, "function");
    assert.equal(typeof binding.collectorStatePath, "function");
  });
}

test("Muse Code uses its pinned ingest binding and reuses the real resolver cache", async () => {
  const bindingModule = await import("./lib/muse-code-run-session-token-collector.mjs");
  const binding = bindingModule.collectorTokenBinding;
  const collectorSource = await readFile(join(scripts, "muse-code-usage-collector.mjs"), "utf8");
  assert.ok(collectorSource.includes('from "./lib/muse-code-run-session-token-collector.mjs"'));
  assert.ok(collectorSource.includes('await resolveCollectorToken(["MUSE_CODE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"])'));

  let keychainToken = tokenFor(binding.grantId);
  let keychainReads = 0;
  let museIngestValue = "muse-ingest-before-change";
  let sharedIngestValue = "shared-ingest-before-change";
  const requests = [];
  const metadata = {
    workspace: binding.project,
    name: binding.account,
    _id: binding.grantId,
    id: binding.grantId,
    scopes: binding.folders.map((secretPath) => ({ environment: "prod", secretPath })),
    permissions: ["read"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const resolve = createScopedCollectorTokenResolver(binding, {
    readKeychain: (account) => {
      keychainReads += 1;
      assert.equal(account, binding.account);
      return { token: keychainToken, status: "ok" };
    },
    fetchImpl: async (input) => {
      const url = new URL(input);
      const secretPath = url.searchParams.get("secretPath");
      requests.push({ path: url.pathname, secretPath });
      if (url.pathname === "/api/v2/service-token") {
        return new Response(JSON.stringify(metadata));
      }
      assert.equal(url.pathname, "/api/v4/secrets");
      assert.equal(url.searchParams.get("projectId"), binding.project);
      assert.equal(url.searchParams.get("environment"), "prod");
      if (secretPath === "/") {
        return new Response(JSON.stringify({
          secrets: [
            { secretKey: "MUSE_CODE_INGEST_TOKEN", secretValue: "${prod.global-api-keys.MUSE_CODE_INGEST_TOKEN}" },
            { secretKey: "USAGE_INGEST_TOKEN", secretValue: "${prod.global-api-keys.USAGE_INGEST_TOKEN}" },
          ],
        }));
      }
      assert.equal(secretPath, "/global-api-keys");
      return new Response(JSON.stringify({
        secrets: [
          { secretKey: "MUSE_CODE_INGEST_TOKEN", secretValue: museIngestValue },
          { secretKey: "USAGE_INGEST_TOKEN", secretValue: sharedIngestValue },
        ],
      }));
    },
  });

  assert.equal(await resolve(["MUSE_CODE_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env: {} }), "muse-ingest-before-change");
  // Change both backing stores after the first read.  A second token-name
  // lookup must use the same resolver's folder cache, not fresh credentials.
  keychainToken = tokenFor("00000000-0000-0000-0000-000000000000");
  museIngestValue = "muse-ingest-after-change";
  sharedIngestValue = "shared-ingest-after-change";
  assert.equal(await resolve(["USAGE_INGEST_TOKEN"], { env: {} }), "shared-ingest-before-change");
  assert.equal(await resolve(["MUSE_CODE_INGEST_TOKEN"], { env: {} }), "muse-ingest-before-change");
  assert.equal(keychainReads, 1);
  assert.deepEqual(requests, [
    { path: "/api/v2/service-token", secretPath: null },
    { path: "/api/v4/secrets", secretPath: "/" },
    { path: "/api/v4/secrets", secretPath: "/global-api-keys" },
  ]);
});

// BEGIN CODEX INJECTED FIXTURES
async function codexInjectedFixture(t, body) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "codex-injected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traps = ["security", "infisical", "fleet-secrets"].map(name => join(directory, name));
  for (const path of traps) await writeFile(path, '#!/bin/sh\nprintf invoked >> "$FIXTURE_AUTH_MARKER"\nexit 97\n', { mode: 0o700 });
  const marker = join(directory, "auth-invoked");
  const program = `
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
const traps = ${JSON.stringify(traps)};
const marker = ${JSON.stringify(marker)};
const childCalls = [], networkCalls = [];
const realExec = cp.execFileSync;
cp.execFileSync = (binary, args, options) => {
  childCalls.push(binary);
  // Refuse any destination outside the inert fixture before spawning.
  assert.ok(traps.includes(binary), "unexpected credential executable");
  return realExec(binary, args, { ...options, timeout: 15000, killSignal: "SIGKILL" });
};
syncBuiltinESMExports();
globalThis.fetch = () => { networkCalls.push(true); throw new Error("unexpected provider request"); };
const binding = await import(${JSON.stringify(pathToFileURL(join(scripts, "lib", "codex-run-session-token-collector.mjs")).href)});
const shared = await import(${JSON.stringify(pathToFileURL(join(scripts, "lib", "run-session-token-collector.mjs")).href)});
const bootstrap = {
  INFISICAL_TOKEN: "st.synthetic-bootstrap", INFISICAL_FLEET_OPS_PROJECT_ID: "synthetic-project",
  INFISICAL_BIN: traps[1], CODEX_SECURITY_BIN: traps[0], COLLECTOR_STRICT_INJECTED_SECRETS: "0",
  INFISICAL_CLIENT_ID: "synthetic-client", INFISICAL_CLIENT_SECRET: "synthetic-secret",
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "synthetic-client", INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "synthetic-secret",
};
${body}
assert.deepEqual(childCalls, [], "Codex must not spawn credential readers");
assert.deepEqual(networkCalls, [], "Codex must not request provider data");
assert.equal(existsSync(marker), false, "inert auth traps must remain unused");
`;
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: program, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
    env: { PATH: directory, HOME: directory, FIXTURE_AUTH_MARKER: marker },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("Codex preserves shared exports and reads injected names in priority order without caching", async (t) => {
  await codexInjectedFixture(t, `
for (const name of Object.keys(shared)) if (name !== "resolveCollectorToken") assert.equal(binding[name], shared[name]);
const names = Object.freeze(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"]);
const env = { ...bootstrap, CODEX_INGEST_TOKEN: "first-output", USAGE_INGEST_TOKEN: "shared-output" };
assert.ok(binding.resolveCollectorToken(names, { env }) === "first-output");
env.CODEX_INGEST_TOKEN = "changed-output";
assert.ok(binding.resolveCollectorToken(names, { env }) === "changed-output");
delete env.CODEX_INGEST_TOKEN;
assert.ok(binding.resolveCollectorToken(names, { env }) === "shared-output");
env.CODEX_INGEST_TOKEN = "  ";
assert.ok(binding.resolveCollectorToken(names, { env }) === "shared-output");
delete env.USAGE_INGEST_TOKEN;
assert.equal(binding.resolveCollectorToken(names, { env }), null);
assert.equal(binding.resolveCollectorToken(undefined, { env: { USAGE_INGEST_TOKEN: "default-output" } }), "default-output");
process.env.CODEX_INGEST_TOKEN = "process-output";
assert.ok(binding.resolveCollectorToken(names) === "process-output");
delete process.env.CODEX_INGEST_TOKEN;
`);
});

test("Codex forces injected mode without mutating options or accepting a lookup bypass", async (t) => {
  await codexInjectedFixture(t, `
let lookups = 0;
const env = Object.freeze({ ...bootstrap });
const options = Object.freeze({ env, fleetSecretsGet: () => { lookups++; throw new Error("synthetic-secret"); } });
assert.equal(binding.resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], options), null);
assert.equal(lookups, 0);
assert.equal(options.env, env);
assert.equal(env.COLLECTOR_STRICT_INJECTED_SECRETS, "0");
assert.equal(Object.keys(options).length, 2);
`);
});

test("Codex missing or partial bootstrap stays environment-only with no auth diagnostics", async (t) => {
  await codexInjectedFixture(t, `
for (const env of [{}, bootstrap, { INFISICAL_TOKEN: "st.fixture" }, { INFISICAL_FLEET_OPS_PROJECT_ID: bootstrap.INFISICAL_FLEET_OPS_PROJECT_ID }, { ...bootstrap, COLLECTOR_STRICT_INJECTED_SECRETS: "1" }]) {
  assert.equal(binding.resolveCollectorToken(["CODEX_INGEST_TOKEN", "USAGE_INGEST_TOKEN"], { env }), null);
}
`);
});
// END CODEX INJECTED FIXTURES

for (const [entry, stem] of Object.entries(ENTRY_POINTS)) {
  test(`the ${entry} entry point uses its own binding and awaits the resolver`, async () => {
    const source = await readFile(join(scripts, entry), "utf8");
    assert.ok(source.includes(`from "./lib/${stem}-run-session-token-collector.mjs"`), entry);
    assert.ok(source.includes("await resolveCollectorToken("), entry);
  });
}

test("every other collector keeps the shared library", async () => {
  for (const entry of SHARED_COLLECTORS) {
    const source = await readFile(join(scripts, entry), "utf8");
    assert.ok(source.includes('from "./lib/run-session-token-collector.mjs"'), entry);
  }
});

test("no collector reads a plaintext token file any more", async () => {
  const files = await readdir(scripts, { recursive: true });
  for (const file of files) {
    const name = String(file);
    if (!name.endsWith(".mjs")) continue;
    if (name === "collector-keychain.node-test.mjs") continue;
    const source = await readFile(join(scripts, file), "utf8");
    assert.ok(!source.includes(".config" + "/infisical/"), name);
  }
});
