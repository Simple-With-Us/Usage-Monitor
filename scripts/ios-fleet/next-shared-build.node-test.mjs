// next-shared-build.node-test.mjs - stub App Store Connect contract for the
// release-build planner (plan-release-build, historical name
// next-shared-build) and for max-platform-build.  Fully offline:  global
// fetch is stubbed through --import, and the credential is a throwaway EC key
// generated here.  No network, no secrets.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextBuildsPageUrl } from "./asc-api.mjs";
import { nextSharedBuild } from "./shared-build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, "asc-api.mjs");
const STAMP = "202610291259";

// The --import stub: answers fetch from ASC_STUB_PLAN_JSON rules (first
// includes-match wins) and logs every requested URL to ASC_STUB_LOG.
const STUB = `import { appendFileSync } from "node:fs";
const logPath = process.env.ASC_STUB_LOG;
const rules = JSON.parse(process.env.ASC_STUB_PLAN_JSON || "[]");
globalThis.fetch = async (url) => {
  const u = String(url);
  appendFileSync(logPath, u + "\\n");
  for (const rule of rules) {
    if (u.includes(rule.match)) {
      return new Response(JSON.stringify(rule.body), {
        status: rule.status || 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
  return new Response(JSON.stringify({ errors: [{ code: "STUB_NO_RULE", detail: u }] }), {
    status: 404,
    headers: { "Content-Type": "application/json" }
  });
};
`;

const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  type: "pkcs8",
  format: "pem"
});
const pemB64 = Buffer.from(pem).toString("base64");

function runClient(method, args, rules) {
  const dir = mkdtempSync(join(tmpdir(), "nsb-test-"));
  const stubPath = join(dir, "fetch-stub.mjs");
  const logPath = join(dir, "urls.log");
  writeFileSync(stubPath, STUB);
  writeFileSync(logPath, "");
  const env = {
    ...process.env,
    APPLE_API_KEY_ID: "TESTKEY0001",
    APPLE_API_ISSUER_ID: "test-issuer",
    APPLE_API_KEY_P8_BASE64: pemB64,
    ASC_STUB_PLAN_JSON: JSON.stringify(rules),
    ASC_STUB_LOG: logPath
  };
  const res = spawnSync(process.execPath, ["--import", stubPath, client, method, ...args], {
    env,
    encoding: "utf8"
  });
  const urls = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, urls };
}

const appRule = (bundle, id) => ({
  match: `filter[bundleId]=${bundle}`,
  body: { data: [{ id, attributes: { bundleId: bundle } }] }
});

const buildsRule = (appId, platform, versions, links) => {
  const body = {
    data: versions.map((v, i) => ({ id: `${appId}-${platform}-${i}`, attributes: { version: v } }))
  };
  if (links !== undefined) body.links = links;
  return { match: `filter[app]=${appId}&filter[preReleaseVersion.platform]=${platform}`, body };
};

const hasBuildsQuery = (urls, appId, platform) =>
  urls.some((u) => u.includes(`filter[app]=${appId}&filter[preReleaseVersion.platform]=${platform}`));

for (const cmd of ["plan-release-build", "next-shared-build"]) {
  test(`${cmd} prints nextSharedBuild for an iOS build, a macOS build and a floor`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", ["1200"]),
      buildsRule("APP1", "MAC_OS", ["1300"])
    ];
    const res = runClient(cmd, ["test.ios", "1400", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), STAMP);
    assert.equal(
      res.stdout.trim(),
      nextSharedBuild({ iosBuilds: ["1200"], macBuilds: ["1300"], extraFloors: [1400], complete: true, mergeStamp: STAMP }).build
    );
    // A pure-integer second arg is a floor, never a bundle id.
    assert.ok(!res.urls.some((u) => u.includes("filter[bundleId]=1400")));
    assert.ok(hasBuildsQuery(res.urls, "APP1", "IOS"));
    assert.ok(hasBuildsQuery(res.urls, "APP1", "MAC_OS"));
  });

  test(`${cmd} plans one past an existing build at or above the stamp`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", ["209912312359"]),
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "209912312360");
  });

  test(`${cmd} counts iOS timestamp builds`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", ["202610190645"]),
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.ios", "--merge-stamp", "202610180000"], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "202610190646");
    assert.ok(!res.stderr.includes("timestamp build(s)"));
  });

  test(`${cmd} collects both platforms for both apps when paired`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      appRule("test.mac", "APP2"),
      buildsRule("APP1", "IOS", ["1100"]),
      buildsRule("APP1", "MAC_OS", []),
      buildsRule("APP2", "IOS", ["1500"]),
      buildsRule("APP2", "MAC_OS", ["1200"])
    ];
    const res = runClient(cmd, ["test.ios", "test.mac", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), STAMP);
    for (const [app, platform] of [["APP1", "IOS"], ["APP1", "MAC_OS"], ["APP2", "IOS"], ["APP2", "MAC_OS"]]) {
      assert.ok(hasBuildsQuery(res.urls, app, platform), `missing builds query ${app} ${platform}`);
    }
  });

  test(`${cmd} collects both platforms for both apps with roles swapped`, () => {
    // The union is symmetric: a macOS ship passing its iOS peer sees the same
    // build as the iOS ship passing its macOS peer.
    const rules = [
      appRule("test.mac", "APP2"),
      appRule("test.ios", "APP1"),
      buildsRule("APP2", "IOS", ["1500"]),
      buildsRule("APP2", "MAC_OS", ["1200"]),
      buildsRule("APP1", "IOS", ["1100"]),
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.mac", "test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), STAMP);
    for (const [app, platform] of [["APP1", "IOS"], ["APP1", "MAC_OS"], ["APP2", "IOS"], ["APP2", "MAC_OS"]]) {
      assert.ok(hasBuildsQuery(res.urls, app, platform), `missing builds query ${app} ${platform}`);
    }
  });

  test(`${cmd} accepts an 18-digit floor and refuses a 19-digit one`, () => {
    const ok = runClient(cmd, ["test.ios", "202610300900123456", "--merge-stamp", STAMP], [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", []),
      buildsRule("APP1", "MAC_OS", [])
    ]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), "202610300900123457");
    const bad = runClient(cmd, ["test.ios", "2026103009001234567", "--merge-stamp", STAMP], [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", []),
      buildsRule("APP1", "MAC_OS", [])
    ]);
    assert.equal(bad.status, 2);
    assert.ok(bad.stderr.includes(`${cmd}: floor`));
    assert.equal(bad.stdout, "");
  });

  test(`${cmd} requires a 12-digit --merge-stamp`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", []),
      buildsRule("APP1", "MAC_OS", [])
    ];
    const missing = runClient(cmd, ["test.ios"], rules);
    assert.equal(missing.status, 2);
    assert.ok(missing.stderr.includes("--merge-stamp"));
    for (const bad of ["1000", "022610291259", "20261029125", "notastamp"]) {
      const res = runClient(cmd, ["test.ios", "--merge-stamp", bad], rules);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes("--merge-stamp"));
      assert.equal(res.stdout, "");
    }
  });

  test(`${cmd} fails closed when builds pagination exceeds the page cap`, () => {
    // A next link on every page would page forever; the client must refuse
    // (exit 2) instead of truncating to a partial inventory.  Rules are
    // first-includes-match-wins, so the numbered page rules run longest-first
    // (page=101 before page=10 before page=2).
    const rules = [
      appRule("test.ios", "APP1"),
      {
        match: "filter[app]=APP1&filter[preReleaseVersion.platform]=IOS",
        body: {
          data: [{ id: "b1", attributes: { version: "1100" } }],
          links: { next: "/v1/builds?page=2" }
        }
      },
      buildsRule("APP1", "MAC_OS", [])
    ];
    for (let page = 101; page >= 2; page--) {
      const body = {
        data: [{ id: `b${page}`, attributes: { version: "1100" } }]
      };
      if (page <= 100) body.links = { next: `/v1/builds?page=${page + 1}` };
      rules.push({ match: `page=${page}`, body });
    }
    const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes(`${cmd}: incomplete pagination`));
  });

  test(`${cmd} follows builds pagination`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      {
        match: "filter[app]=APP1&filter[preReleaseVersion.platform]=IOS",
        body: {
          data: [{ id: "b1", attributes: { version: "1100" } }],
          links: { next: "/v1/builds?page=2" }
        }
      },
      { match: "page=2", body: { data: [{ id: "b2", attributes: { version: "1500" } }] } },
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), STAMP);
  });

  for (const [name, links] of [
    ["links as string", "https://example.invalid/next"],
    ["links as array", []],
    ["links.next as number", { next: 42 }],
    ["links.next as object", { next: {} }]
  ]) {
    test(`${cmd} refuses malformed pagination (${name})`, () => {
      const rules = [
        appRule("test.ios", "APP1"),
        buildsRule("APP1", "IOS", ["1200"], links),
        buildsRule("APP1", "MAC_OS", [])
      ];
      const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.includes(`${cmd}: malformed pagination`));
    });
  }

  test(`${cmd} refuses a non-object builds page`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      { match: "filter[app]=APP1&filter[preReleaseVersion.platform]=IOS", body: [] },
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes(`${cmd}: malformed pagination`));
  });

  test(`${cmd} fails closed on a malformed build value`, () => {
    const rules = [
      appRule("test.ios", "APP1"),
      buildsRule("APP1", "IOS", ["NaN"]),
      buildsRule("APP1", "MAC_OS", [])
    ];
    const res = runClient(cmd, ["test.ios", "--merge-stamp", STAMP], rules);
    assert.equal(res.status, 3);
    assert.ok(res.stderr.includes("malformed build inventory"));
    assert.equal(res.stdout, "");
  });
}

test("max-platform-build prints the highest first component on that platform only", () => {
  const rules = [
    appRule("test.ios", "APP1"),
    buildsRule("APP1", "IOS", ["202610190645", "2394", "202610300900.1"]),
    buildsRule("APP1", "MAC_OS", ["209912312359"])
  ];
  const ios = runClient("max-platform-build", ["test.ios", "IOS"], rules);
  assert.equal(ios.status, 0);
  assert.equal(ios.stdout.trim(), "202610300900");
  assert.ok(hasBuildsQuery(ios.urls, "APP1", "IOS"));
  assert.ok(!hasBuildsQuery(ios.urls, "APP1", "MAC_OS"));
  const mac = runClient("max-platform-build", ["test.ios", "MAC_OS"], rules);
  assert.equal(mac.status, 0);
  assert.equal(mac.stdout.trim(), "209912312359");
});

test("max-platform-build prints 0 when the platform has no builds", () => {
  const rules = [
    appRule("test.ios", "APP1"),
    buildsRule("APP1", "IOS", []),
    buildsRule("APP1", "MAC_OS", [])
  ];
  const res = runClient("max-platform-build", ["test.ios", "IOS"], rules);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "0");
});

test("max-platform-build fails closed on malformed inventory", () => {
  const badValue = runClient("max-platform-build", ["test.ios", "IOS"], [
    appRule("test.ios", "APP1"),
    buildsRule("APP1", "IOS", ["NaN"]),
    buildsRule("APP1", "MAC_OS", [])
  ]);
  assert.equal(badValue.status, 3);
  assert.ok(badValue.stderr.includes("malformed build inventory"));
  const badPlatform = runClient("max-platform-build", ["test.ios", "TVOS"], [
    appRule("test.ios", "APP1"),
    buildsRule("APP1", "IOS", []),
    buildsRule("APP1", "MAC_OS", [])
  ]);
  assert.equal(badPlatform.status, 2);
  const missingApp = runClient("max-platform-build", ["test.unknown", "IOS"], [
    { match: "filter[bundleId]=test.unknown", body: { data: [] } }
  ]);
  assert.equal(missingApp.status, 2);
  assert.ok(missingApp.stderr.includes("app not found"));
});

test("nextBuildsPageUrl accepts absent or null links/next", () => {
  assert.equal(nextBuildsPageUrl({ data: [] }), "");
  assert.equal(nextBuildsPageUrl({ data: [], links: null }), "");
  assert.equal(nextBuildsPageUrl({ data: [], links: {} }), "");
  assert.equal(nextBuildsPageUrl({ data: [], links: { next: null } }), "");
  assert.equal(nextBuildsPageUrl({ data: [], links: { next: "/v1/builds?page=2" } }), "/v1/builds?page=2");
});

test("nextBuildsPageUrl rejects malformed pagination", () => {
  for (const bad of [
    null, undefined, 42, "x", [],
    { links: "x" }, { links: [] }, { links: 7 },
    { links: { next: 42 } }, { links: { next: {} } }, { links: { next: ["x"] } }
  ]) {
    assert.throws(() => nextBuildsPageUrl(bad), /next-shared-build: malformed pagination/);
    assert.throws(() => nextBuildsPageUrl(bad, "plan-release-build"), /plan-release-build: malformed pagination/);
  }
});
