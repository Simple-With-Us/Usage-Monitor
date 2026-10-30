import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptPath =
  process.env.INFISICAL_RUN_SCRIPT || fileURLToPath(new URL("./infisical-run.mjs", import.meta.url));
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
