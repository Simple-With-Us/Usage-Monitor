import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignBuildToExternalGroups } from "./asc-api.mjs";

const scriptUrl = new URL("./assign-external-beta.sh", import.meta.url);
const shipUrl = new URL("./ship-testflight.sh", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ios-ship.yml", import.meta.url);

function group(id, name, internal, extra = {}) {
  return { id, attributes: { name, isInternalGroup: internal, publicLinkEnabled: false, ...extra } };
}

function buildRow(id, version, processingState = "VALID") {
  return { id, attributes: { version, processingState } };
}

function response(status, parsed) {
  return { status, ok: status >= 200 && status < 300, parsed };
}

test("attaches a valid build only to existing external groups and submits review once", async () => {
  const state = { members: { pub: [], other: [] }, submitted: 0 };
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/v1/apps/6820881005/betaGroups")) {
      return response(200, { data: [
        group("pub", "Public Beta", false, { publicLinkEnabled: true }),
        group("other", "Friends", false),
        group("int", "Internal Testers", true)
      ] });
    }
    if (method === "GET" && path.startsWith("/v1/builds?")) {
      return response(200, { data: [buildRow("build-new", "0.1.0")] });
    }
    if (method === "GET" && path.startsWith("/v1/betaGroups/pub/builds")) {
      return response(200, { data: [buildRow("build-old", "0.0.9")] });
    }
    if (method === "GET" && path.startsWith("/v1/betaGroups/other/builds")) {
      return response(200, { data: [buildRow("build-new", "0.1.0")] });
    }
    if (method === "POST" && path === "/v1/betaGroups/pub/relationships/builds") {
      state.members.pub.push("build-new");
      return response(204, {});
    }
    if (method === "GET" && path === "/v1/builds/build-new/buildBetaDetail") {
      return response(200, { data: { attributes: { externalBuildState: "READY_FOR_BETA_SUBMISSION" } } });
    }
    if (method === "POST" && path === "/v1/betaAppReviewSubmissions") {
      state.submitted += 1;
      return response(201, { data: { id: "sub-1" } });
    }
    return response(500, { errors: [{ detail: `unhandled ${method} ${path}` }] });
  };

  const first = await assignBuildToExternalGroups({ api, appId: "6820881005", buildVersion: "0.1.0", marketingVersion: "0.1.0" });
  assert.equal(first.ok, true);
  assert.deepEqual(first.assigned.map((row) => row.name), ["Public Beta"]);
  assert.deepEqual(first.already.map((row) => row.name), ["Friends"]);
  assert.equal(first.submitted, true);
  assert.equal(calls.some((call) => call.path.includes("betaTesters")), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/v1/betaGroups"), false);
  assert.equal(calls.some((call) => String(call.path).includes("/int/")), false);
  const link = calls.find((call) => call.method === "POST" && call.path.endsWith("/relationships/builds"));
  assert.deepEqual(JSON.parse(link.body), { data: [{ type: "builds", id: "build-new" }] });

  const secondCalls = [];
  const again = async (method, path, body) => {
    secondCalls.push({ method, path });
    if (method === "GET" && path.startsWith("/v1/apps/6820881005/betaGroups")) {
      return response(200, { data: [group("pub", "Public Beta", false), group("other", "Friends", false)] });
    }
    if (method === "GET" && path.startsWith("/v1/builds?")) {
      return response(200, { data: [buildRow("build-new", "0.1.0")] });
    }
    if (method === "GET" && path.includes("/builds")) {
      return response(200, { data: [buildRow("build-new", "0.1.0")] });
    }
    if (method === "GET" && path.endsWith("/buildBetaDetail")) {
      return response(200, { data: { attributes: { externalBuildState: "IN_BETA_TESTING" } } });
    }
    return response(500, { errors: [{ detail: `unhandled ${method} ${path}` }] });
  };
  const second = await assignBuildToExternalGroups({ api: again, appId: "6820881005", buildVersion: "0.1.0", marketingVersion: "0.1.0" });
  assert.equal(second.ok, true);
  assert.equal(second.submitted, false);
  assert.deepEqual(second.assigned, []);
  assert.equal(secondCalls.some((call) => call.method === "POST"), false);
});

test("a build already listed on a later page is not posted again", async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push({ method, path });
    if (path.startsWith("/v1/apps/1/betaGroups")) {
      return response(200, { data: [group("pub", "Public Beta", false)] });
    }
    if (path.startsWith("/v1/builds?")) return response(200, { data: [buildRow("build-new", "9")] });
    if (path.includes("page=2")) return response(200, { data: [buildRow("build-new", "9")] });
    if (path.startsWith("/v1/betaGroups/pub/builds")) {
      return response(200, { data: [buildRow("older", "8")], links: { next: "/v1/betaGroups/pub/builds?page=2" } });
    }
    if (path.endsWith("/buildBetaDetail")) {
      return response(200, { data: { attributes: { externalBuildState: "IN_BETA_REVIEW" } } });
    }
    return response(500, { errors: [{ detail: path }] });
  };
  const result = await assignBuildToExternalGroups({ api, appId: "1", buildVersion: "9" });
  assert.equal(result.ok, true);
  assert.equal(result.already.length, 1);
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("no external group means no build lookup and no write", async () => {
  const calls = [];
  const api = async (method, path) => {
    calls.push({ method, path });
    return response(200, { data: [group("int", "Internal Testers", true), { id: "bare", attributes: { name: "Unknown" } }] });
  };
  const result = await assignBuildToExternalGroups({ api, appId: "1", buildVersion: "9" });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-external-groups");
  assert.equal(calls.length, 1);
});

test("an unreadable group list and a build that is not ready do not write", async () => {
  const denied = [];
  const result = await assignBuildToExternalGroups({
    api: async (method, path) => {
      denied.push({ method, path });
      return response(403, { errors: [{ detail: "no" }] });
    },
    appId: "1",
    buildVersion: "9"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "groups-unreadable");
  assert.deepEqual(denied, [{ method: "GET", path: "/v1/apps/1/betaGroups?limit=200&fields[betaGroups]=name,isInternalGroup,publicLinkEnabled" }]);

  const calls = [];
  const processing = await assignBuildToExternalGroups({
    api: async (method, path) => {
      calls.push(method + " " + path);
      if (path.includes("betaGroups?")) return response(200, { data: [group("pub", "Public Beta", false)] });
      return response(200, { data: [buildRow("build-new", "9", "PROCESSING")] });
    },
    appId: "1",
    buildVersion: "9"
  });
  assert.equal(processing.reason, "build-not-valid");
  assert.equal(calls.some((call) => call.startsWith("POST")), false);
});

test("an ambiguous build and a failed review submission stay unwritten or partial", async () => {
  const ambiguous = await assignBuildToExternalGroups({
    api: async (_method, path) => {
      if (path.includes("betaGroups?")) return response(200, { data: [group("pub", "Public Beta", false)] });
      return response(200, { data: [buildRow("a", "9"), buildRow("b", "9")] });
    },
    appId: "1",
    buildVersion: "9"
  });
  assert.equal(ambiguous.reason, "build-ambiguous");

  const posts = [];
  const partial = await assignBuildToExternalGroups({
    api: async (method, path) => {
      if (method === "POST") posts.push(path);
      if (path.includes("/betaGroups?")) return response(200, { data: [group("pub", "Public Beta", false)] });
      if (method === "GET" && path.startsWith("/v1/builds?")) return response(200, { data: [buildRow("build-new", "9")] });
      if (method === "GET" && path.startsWith("/v1/betaGroups/pub/builds")) return response(200, { data: [] });
      if (method === "POST" && path.endsWith("/relationships/builds")) return response(204, {});
      if (method === "GET" && path.endsWith("/buildBetaDetail")) {
        return response(200, { data: { attributes: { externalBuildState: "READY_FOR_BETA_SUBMISSION" } } });
      }
      if (method === "POST" && path === "/v1/betaAppReviewSubmissions") {
        return response(422, { errors: [{ code: "ENTITY_ERROR", detail: "missing description" }] });
      }
      return response(500, { errors: [{ detail: path }] });
    },
    appId: "1",
    buildVersion: "9"
  });
  assert.equal(partial.ok, false);
  assert.equal(partial.submitted, false);
  assert.match(partial.submitError, /missing description/);
  assert.deepEqual(posts, ["/v1/betaGroups/pub/relationships/builds", "/v1/betaAppReviewSubmissions"]);
});

test("a conflicting relationship is re-read and treated as already assigned", async () => {
  let reads = 0;
  const result = await assignBuildToExternalGroups({
    api: async (method, path) => {
      if (path.includes("betaGroups?")) return response(200, { data: [group("pub", "Public Beta", false)] });
      if (path.startsWith("/v1/builds?")) return response(200, { data: [buildRow("build-new", "9")] });
      if (method === "GET" && path.includes("/builds")) {
        reads += 1;
        return response(200, { data: reads === 1 ? [] : [buildRow("build-new", "9")] });
      }
      if (method === "POST" && path.endsWith("/relationships/builds")) return response(409, { errors: [{ detail: "already" }] });
      if (path.endsWith("/buildBetaDetail")) {
        return response(200, { data: { attributes: { externalBuildState: "BETA_APPROVED" } } });
      }
      return response(500, { errors: [{ detail: path }] });
    },
    appId: "1",
    buildVersion: "9"
  });
  assert.equal(result.ok, true);
  assert.equal(result.already.length, 1);
  assert.equal(result.assigned.length, 0);
  assert.equal(result.submitted, false);
});

test("the wrapper calls App Store Connect only when the ship job sets the flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "um-1640-node-"));
  const log = join(dir, "argv");
  const stub = join(dir, "node");
  writeFileSync(stub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ASC_NODE_LOG\"\nexit 0\n");
  chmodSync(stub, 0o755);
  const env = { ...process.env, ASC_NODE: stub, ASC_NODE_LOG: log, IOS_ASSIGN_EXTERNAL_BETA: "" };
  const skipped = spawnSync("bash", [scriptUrl.pathname, "6820881005", "0.1.0"], { env, encoding: "utf8" });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stderr, /only the normal ship job/);
  assert.equal(existsSync(log), false);

  const zero = spawnSync("bash", [scriptUrl.pathname, "6820881005", "0.1.0"], {
    env: { ...env, IOS_ASSIGN_EXTERNAL_BETA: "0" },
    encoding: "utf8"
  });
  assert.equal(zero.status, 0);
  assert.equal(existsSync(log), false);

  const shipped = spawnSync("bash", [scriptUrl.pathname, "6820881005", "0.1.0", "0.1.0"], {
    env: { ...env, IOS_ASSIGN_EXTERNAL_BETA: "1" },
    encoding: "utf8"
  });
  assert.equal(shipped.status, 0);
  assert.match(readFileSync(log, "utf8"), /assign-external-beta\n6820881005\n0\.1\.0\n0\.1\.0/);
});

test("the ship script and workflow keep assignment inside the two ship steps", () => {
  const ship = readFileSync(shipUrl, "utf8");
  const readyStart = ship.indexOf("ensure_tf_ready() {");
  const readyEnd = ship.indexOf("\n}\n", readyStart);
  assert.equal(ship.slice(readyStart, readyEnd).includes("assign_external_beta"), false);
  assert.equal(ship.includes('publish-ios-versions.sh" "${pub_args[@]}" >/dev/null'), false);
  assert.equal(ship.match(/assign_external_beta\n\s*record_successful_ship/g).length, 3);

  const workflow = readFileSync(workflowUrl, "utf8");
  const steps = workflow.split("\n      - name: ");
  const body = (name) => steps.find((step) => step.startsWith(name));
  for (const name of ["Ship UsageMonitor to TestFlight", "Ship LocalUsageMonitor to TestFlight"]) {
    const step = body(name);
    assert.match(step, /IOS_ASSIGN_EXTERNAL_BETA: "1"/);
    assert.match(step, /GH_TOKEN: \$\{\{ secrets\.GH_PAT \}\}/);
  }
  for (const name of [
    "Sync standing TestFlight testers (usage)",
    "Sync standing TestFlight testers (usage-local)",
    "Plan release builds (once per app per release)"
  ]) {
    assert.doesNotMatch(body(name), /IOS_ASSIGN_EXTERNAL_BETA/);
  }
});
