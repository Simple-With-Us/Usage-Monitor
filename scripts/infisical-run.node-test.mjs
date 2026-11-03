import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertServiceTokenMetadata, verifyServiceToken } from "./lib/infisical-service-token.mjs";

const scriptPath =
  process.env.INFISICAL_RUN_SCRIPT || fileURLToPath(new URL("./infisical-run.mjs", import.meta.url));
const tokenCheckPath = fileURLToPath(new URL("./check-infisical-token.mjs", import.meta.url));
const timeoutMs = 3000;
const startupTimeoutMs = 10000;

async function makeFakeInfisical(mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "infisical-run-test-"));
  const binPath = path.join(root, "bin");
  const markerPath = path.join(root, "child-pid");
  const signalPath = path.join(root, "child-signal");
  const versionPath = path.join(root, "version-probe");
  await mkdir(binPath);
  await symlink(process.execPath, path.join(binPath, "node"));

  const executablePath = path.join(binPath, "infisical");
  await writeFile(
    executablePath,
    `#!/usr/bin/env node
const { unlinkSync, writeFileSync } = require("node:fs");

if (process.argv[2] === "--version") {
  writeFileSync(process.env.FAKE_INFISICAL_VERSION_FILE, "probed");
  if (process.env.FAKE_INFISICAL_MODE === "self-delete") unlinkSync(process.argv[1]);
  process.exit(0);
}
writeFileSync(process.env.FAKE_INFISICAL_PID_FILE, String(process.pid));
if (process.env.FAKE_INFISICAL_MODE === "bindings") {
  writeFileSync(process.env.FAKE_INFISICAL_SIGNAL_FILE, JSON.stringify({ project: process.env.INFISICAL_UM_PROJECT_ID, path: process.env.INFISICAL_UM_SECRET_PATH, token: process.env.INFISICAL_UM_READ_TOKEN }));
  process.exit(0);
}
if (process.env.FAKE_INFISICAL_MODE === "exit") process.exit(37);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    writeFileSync(process.env.FAKE_INFISICAL_SIGNAL_FILE, signal);
    process.exit(0);
  });
}
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  await chmod(executablePath, 0o700);

  return {
    root,
    markerPath,
    signalPath,
    versionPath,
    env: {
      PATH: binPath,
      INFISICAL_PROJECT_ID: "fake-project",
      INFISICAL_TOKEN: "test-only-token",
      FAKE_INFISICAL_MODE: mode,
      FAKE_INFISICAL_PID_FILE: markerPath,
      FAKE_INFISICAL_SIGNAL_FILE: signalPath,
      FAKE_INFISICAL_VERSION_FILE: versionPath,
    },
  };
}

async function waitForMarker(markerPath) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(markerPath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error("fake Infisical process did not start in time");
}

async function waitForChildExit(pid) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error("fake Infisical process did not exit in time");
}

function killIfRunning(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function killProcessGroup(wrapper) {
  if (!wrapper?.pid) return;
  try {
    process.kill(-wrapper.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("wrapper did not exit in time")), timeoutMs);
    once(child, "exit").then(([code, signal]) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    }, reject);
  });
}

async function runWithFakeInfisical(mode, verify) {
  const fake = await makeFakeInfisical(mode);
  let wrapper;
  let childPid;
  const stderr = [];
  try {
    wrapper = spawn(process.execPath, [scriptPath, "--", "node", "-e", "0"], {
      env: fake.env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    wrapper.stderr.setEncoding("utf8");
    wrapper.stderr.on("data", (chunk) => stderr.push(chunk));
    if (mode !== "self-delete") childPid = await waitForMarker(fake.markerPath);
    await verify({ wrapper, fake, childPid, stderr });
  } finally {
    try {
      killIfRunning(childPid);
      killProcessGroup(wrapper);
      if (childPid) await waitForChildExit(childPid);
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) {
        await waitForExit(wrapper);
      }
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`forwards ${signal} to Infisical and exits after the child handles it`, async () => {
    await runWithFakeInfisical("wait", async ({ wrapper, fake, childPid }) => {
      wrapper.kill(signal);
      const result = await waitForExit(wrapper);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(await readFile(fake.signalPath, "utf8"), signal);
      await waitForChildExit(childPid);
    });
  });
}

test("propagates the Infisical exit code", async () => {
  await runWithFakeInfisical("exit", async ({ wrapper }) => {
    const result = await waitForExit(wrapper);
    assert.equal(result.code, 37);
    assert.equal(result.signal, null);
  });
});

test("reports asynchronous CLI spawn errors and exits 127", async () => {
  await runWithFakeInfisical("self-delete", async ({ wrapper, fake, stderr }) => {
    const result = await waitForExit(wrapper);
    assert.equal(result.code, 127);
    assert.equal(result.signal, null);
    assert.equal(stderr.join(""), "[infisical] Failed to start Infisical CLI (ENOENT).\n");
    assert.equal(await readFile(fake.versionPath, "utf8"), "probed");
    await assert.rejects(readFile(fake.markerPath), { code: "ENOENT" });
  });
});

test("normalizes a metadata-verified generic UM token and folder for the app child", async () => {
  const fake = await makeFakeInfisical("bindings");
  try {
    const loader = path.join(fake.root, "fetch.mjs");
    await writeFile(loader, `globalThis.fetch = async () => new Response(JSON.stringify({workspace:"fake-project",permissions:["read"],scopes:[{environment:"prod",secretPath:"/config"}],expiresAt:null}));`);
    const child = spawn(process.execPath, ["--import", loader, scriptPath, "--", "node", "-e", "0"], { env: { ...fake.env, INFISICAL_TOKEN: "st.fake-read", INFISICAL_PATH: "/config" }, stdio: "ignore" });
    assert.equal((await waitForExit(child)).code, 0);
    assert.deepEqual(JSON.parse(await readFile(fake.signalPath, "utf8")), { project: "fake-project", path: "/config", token: "st.fake-read" });
  } finally { await rm(fake.root, { recursive: true, force: true }); }
});

test("metadata verifier rejects wrong project, folder, excess permission, expiry and credential egress", async () => {
  const expected = { projectId: "fake-project", paths: ["/config"], permissions: ["read"] };
  const metadata = { workspace: "fake-project", scopes: [{ environment: "prod", secretPath: "/config" }], permissions: ["read"] };
  assert.doesNotThrow(() => assertServiceTokenMetadata(metadata, expected));
  for (const override of [{workspace:"wrong"}, {scopes:[{environment:"prod",secretPath:"/"}]}, {permissions:["read","write"]}, {expiresAt:"2020-01-01T00:00:00Z"}]) assert.throws(() => assertServiceTokenMetadata({...metadata,...override}, expected));
  let calls = 0;
  await assert.rejects(verifyServiceToken({ ...expected, token: "st.fake-secret", baseUrl: "https://evil.test", fetchImpl: async () => { calls++; throw new Error("st.fake-secret"); } }), { message: "service_token_verification_failed" });
  assert.equal(calls, 0);
});

test("child token check prefers scoped UM read and write tokens over a different generic token", async () => {
  for (const permission of ["read", "write"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "infisical-token-check-test-"));
    try {
      const observedPath = path.join(root, "observed-token");
      const loader = path.join(root, "fake-fetch.mjs");
      await writeFile(loader, `
import { writeFileSync } from "node:fs";
globalThis.fetch = async (_url, options = {}) => {
  const token = new Headers(options.headers).get("authorization")?.replace(/^Bearer /, "") || "";
  writeFileSync(process.env.FAKE_OBSERVED_TOKEN_FILE, token);
  const matches = token === process.env.FAKE_EXPECTED_TOKEN;
  const metadata = {
    workspace: matches ? "fake-project" : "wrong-project",
    permissions: [process.env.FAKE_EXPECTED_PERMISSION],
    scopes: [{ environment: "prod", secretPath: "/" }],
    expiresAt: null,
  };
  return new Response(JSON.stringify(metadata), { status: 200 });
};
`);

      const scopedToken = permission === "read" ? "st.fake-um-read-token" : "st.fake-um-write-token";
      const child = spawn(process.execPath, ["--import", loader, tokenCheckPath, permission], {
        env: {
          PATH: process.env.PATH,
          FAKE_OBSERVED_TOKEN_FILE: observedPath,
          FAKE_EXPECTED_TOKEN: scopedToken,
          FAKE_EXPECTED_PERMISSION: permission,
          INFISICAL_UM_PROJECT_ID: "fake-project",
          INFISICAL_UM_SECRET_PATH: "/",
          INFISICAL_UM_READ_TOKEN: "st.fake-um-read-token",
          INFISICAL_UM_WRITE_TOKEN: "st.fake-um-write-token",
          INFISICAL_TOKEN: "st.fake-generic-token",
        },
        stdio: "ignore",
      });
      const result = await waitForExit(child);
      assert.equal(result.code, 0, `${permission} token metadata must verify`);
      assert.equal(await readFile(observedPath, "utf8"), scopedToken);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
