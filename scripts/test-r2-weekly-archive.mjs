#!/usr/bin/env node
/**
 * Tests for the weekly R2 archive and its SigV4 signer.
 *
 * Runs standalone (no vitest) to match the other deploy-critical script tests
 * in this repo, and uses an in-memory S3 stub so the whole upload → verify →
 * prune flow is exercised without touching a real bucket or a credential.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { awsUriEncode, signS3Request } from "./lib/s3-sigv4.mjs";
import {
  archiveKeyFor,
  classifyFailure,
  isManagedArchiveKey,
  resolveArchiveConfig,
  runArchive,
  selectPruneTargets,
} from "./ops/r2-weekly-archive.mjs";

let failures = 0;
let passes = 0;

async function test(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.message}`);
  }
}

// ---------------------------------------------------------------- signer ----

await test("awsUriEncode escapes what encodeURIComponent leaves behind", () => {
  // These five are the classic SigV4 footgun: encodeURIComponent passes them
  // through, AWS requires them escaped, and the result is a signature mismatch
  // that looks exactly like a bad credential.
  assert.equal(awsUriEncode("!'()*"), "%21%27%28%29%2A");
  assert.equal(awsUriEncode("abcXYZ019-_.~"), "abcXYZ019-_.~");
  assert.equal(awsUriEncode("a/b"), "a%2Fb");
  assert.equal(awsUriEncode("a/b", false), "a/b");
  assert.equal(awsUriEncode("é"), "%C3%A9");
  assert.equal(awsUriEncode("a b"), "a%20b");
});

await test("signS3Request builds a deterministic, correctly ordered signature", () => {
  const creds = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  };
  const now = new Date("2026-08-12T09:48:45.000Z");
  const first = signS3Request({
    method: "PUT",
    creds,
    bucket: "b",
    key: "weekly/prod.db.gz",
    body: Buffer.from("payload"),
    headers: { "content-type": "application/gzip", "x-amz-meta-sha256": "abc" },
    now,
  });
  const second = signS3Request({
    method: "PUT",
    creds,
    bucket: "b",
    key: "weekly/prod.db.gz",
    body: Buffer.from("payload"),
    headers: { "content-type": "application/gzip", "x-amz-meta-sha256": "abc" },
    now,
  });

  assert.equal(first.headers.authorization, second.headers.authorization, "signing must be deterministic");
  assert.match(first.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  // region "auto" is not a real SigV4 region; R2 expects us-east-1 in the scope.
  assert.match(first.headers.authorization, /\/20260812\/us-east-1\/s3\/aws4_request/);
  // Signed headers must be lexically sorted or the server recomputes a different hash.
  assert.match(
    first.headers.authorization,
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256/
  );
  assert.equal(first.url, "https://acct.r2.cloudflarestorage.com/b/weekly/prod.db.gz");
  // Real payload hash, never UNSIGNED-PAYLOAD — a truncated body must fail server-side.
  assert.notEqual(first.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
  assert.match(first.headers["x-amz-content-sha256"], /^[0-9a-f]{64}$/);
});

await test("signS3Request changes signature when the body changes", () => {
  const creds = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
  };
  const now = new Date("2026-08-12T00:00:00.000Z");
  const a = signS3Request({ method: "PUT", creds, bucket: "b", key: "k", body: "one", now });
  const b = signS3Request({ method: "PUT", creds, bucket: "b", key: "k", body: "two", now });
  assert.notEqual(a.headers.authorization, b.headers.authorization);
});

await test("signS3Request sorts query parameters canonically", () => {
  const creds = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "AKID",
    secretAccessKey: "secret",
  };
  const { url } = signS3Request({
    method: "GET",
    creds,
    bucket: "b",
    query: { prefix: "weekly/", "list-type": "2" },
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  assert.equal(url, "https://acct.r2.cloudflarestorage.com/b?list-type=2&prefix=weekly%2F");
});

// ------------------------------------------------------------ retention ----

await test("archiveKeyFor sorts lexically in chronological order", () => {
  const older = archiveKeyFor("weekly/", new Date("2026-08-05T00:00:00.000Z"));
  const newer = archiveKeyFor("weekly/", new Date("2026-08-12T00:00:00.000Z"));
  assert.ok(older < newer, `${older} should sort before ${newer}`);
  assert.match(newer, /^weekly\/prod-2026-08-12T00-00-00Z\.db\.gz$/);
});

await test("selectPruneTargets keeps the fresh upload plus keep-1 older generations", () => {
  const objects = [
    { key: "weekly/prod-2026-07-22T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-07-29T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-05T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-12T00-00-00Z.db.gz" },
  ];
  const fresh = "weekly/prod-2026-08-12T00-00-00Z.db.gz";

  assert.deepEqual(selectPruneTargets(objects, fresh, 2), [
    "weekly/prod-2026-07-29T00-00-00Z.db.gz",
    "weekly/prod-2026-07-22T00-00-00Z.db.gz",
  ]);
  // keep=1 is the strict "delete the old one once the new one is verified" mode.
  assert.deepEqual(selectPruneTargets(objects, fresh, 1), [
    "weekly/prod-2026-08-05T00-00-00Z.db.gz",
    "weekly/prod-2026-07-29T00-00-00Z.db.gz",
    "weekly/prod-2026-07-22T00-00-00Z.db.gz",
  ]);
});

await test("selectPruneTargets never proposes deleting the fresh upload", () => {
  const fresh = "weekly/prod-2026-08-12T00-00-00Z.db.gz";
  const targets = selectPruneTargets([{ key: fresh }], fresh, 1);
  assert.deepEqual(targets, []);
});

await test("selectPruneTargets ignores unrelated objects in the bucket", () => {
  const objects = [
    { key: "weekly/prod-2026-08-12T00-00-00Z.db.gz" },
    { key: "weekly/README.txt" },
    { key: "api-usage-monitor/prod.db/0001/0000.ltx" },
  ];
  const targets = selectPruneTargets(objects, "weekly/prod-2026-08-12T00-00-00Z.db.gz", 1);
  assert.deepEqual(targets, [], "litestream history and non-archive keys are never pruned");
});

await test("only keys this job could have written are ever DELETE candidates", () => {
  // The candidate list comes from a ListObjectsV2 response — i.e. from outside
  // this process. Without an allowlist a malformed or hostile listing could
  // steer DELETE at the frozen litestream history.
  assert.equal(isManagedArchiveKey("weekly/prod-2026-08-12T00-00-00Z.db.gz", "weekly/"), true);
  assert.equal(isManagedArchiveKey("weekly/prod-nope.db.gz", "weekly/"), false);
  assert.equal(isManagedArchiveKey("weekly/../../etc/passwd", "weekly/"), false);
  assert.equal(isManagedArchiveKey("other/prod-2026-08-12T00-00-00Z.db.gz", "weekly/"), false);
  assert.equal(isManagedArchiveKey("api-usage-monitor/prod.db/0001/0000.ltx", "weekly/"), false);
  assert.equal(isManagedArchiveKey(null, "weekly/"), false);

  const hostile = [
    { key: "weekly/prod-2026-08-12T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-05T00-00-00Z.db.gz" },
    { key: "api-usage-monitor/prod.db/0001/0000.ltx" },
    { key: "weekly/../api-usage-monitor/prod.db/0001/0001.ltx" },
  ];
  assert.deepEqual(
    selectPruneTargets(hostile, "weekly/prod-2026-08-12T00-00-00Z.db.gz", 1, "weekly/"),
    ["weekly/prod-2026-08-05T00-00-00Z.db.gz"]
  );
});

// ------------------------------------------------------------ failures ----

await test("classifyFailure never lets remote error text reach the status file", () => {
  assert.equal(
    classifyFailure(new Error("missing R2 archive credentials: R2_ARCHIVE_ENDPOINT")),
    "credentials_missing"
  );
  assert.equal(classifyFailure(new Error("uploaded object hash mismatch: local a vs remote b")), "verify_hash_mismatch");
  assert.equal(classifyFailure(new Error("restored size mismatch: 1 vs 2")), "verify_size_mismatch");
  assert.equal(
    classifyFailure(new Error('S3 PUT b/k failed: HTTP 401 <?xml?><Error><Code>Unauthorized</Code></Error>')),
    "upload_failed"
  );
  assert.equal(classifyFailure(new Error("something nobody anticipated")), "archive_failed");

  // Every code must be a bare snake_case token — the app validates the shape
  // before rendering it, so anything else would be discarded as unlabelled.
  for (const error of [
    new Error("S3 GET x failed: HTTP 500 <html>boom</html>"),
    new Error("S3 DELETE x failed: HTTP 403"),
    new Error("PRAGMA integrity_check returned garbage"),
    new Error("kill switch is engaged"),
    new Error("database not found at /data/prod.db"),
  ]) {
    assert.match(classifyFailure(error), /^[a-z_]{1,40}$/);
  }
});

// --------------------------------------------------------------- config ----

await test("resolveArchiveConfig refuses to fall back to the B2 litestream keys", () => {
  const config = resolveArchiveConfig({
    LITESTREAM_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com",
    LITESTREAM_S3_ACCESS_KEY_ID: "b2-key",
    LITESTREAM_S3_SECRET_ACCESS_KEY: "b2-secret",
  });
  assert.deepEqual(config.missing, [
    "R2_ARCHIVE_ENDPOINT",
    "R2_ARCHIVE_ACCESS_KEY_ID",
    "R2_ARCHIVE_SECRET_ACCESS_KEY",
  ]);
  assert.equal(config.creds.accessKeyId, "", "B2 credentials must never leak into an R2 request");
});

await test("resolveArchiveConfig anchors work dir on the data volume beside the DB", () => {
  const config = resolveArchiveConfig({
    R2_ARCHIVE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_ARCHIVE_ACCESS_KEY_ID: "k",
    R2_ARCHIVE_SECRET_ACCESS_KEY: "s",
    R2_ARCHIVE_DB_PATH: "/data/prod.db",
  });
  assert.equal(config.workDirBase, "/data/.r2-archive-work");
  const overridden = resolveArchiveConfig(
    {
      R2_ARCHIVE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      R2_ARCHIVE_ACCESS_KEY_ID: "k",
      R2_ARCHIVE_SECRET_ACCESS_KEY: "s",
      R2_ARCHIVE_DB_PATH: "/data/prod.db",
      R2_ARCHIVE_WORK_DIR: "/opt/r2-work",
    }
  );
  assert.equal(overridden.workDirBase, "/opt/r2-work");
});

await test("resolveArchiveConfig normalizes prefix and detects the kill switch", () => {
  const config = resolveArchiveConfig({
    R2_ARCHIVE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_ARCHIVE_ACCESS_KEY_ID: "k",
    R2_ARCHIVE_SECRET_ACCESS_KEY: "s",
    R2_ARCHIVE_PREFIX: "archives",
    R2_WRITES_DISABLED: "true",
  });
  assert.deepEqual(config.missing, []);
  assert.equal(config.prefix, "archives/");
  assert.equal(config.killSwitchEngaged, true);
  assert.equal(config.ignoreKillSwitch, false);
  assert.equal(config.keepGenerations, 2);
});

// ------------------------------------------------------------ end to end ----

function makeDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE budget (id INTEGER PRIMARY KEY, provider TEXT, cents INTEGER)");
  const insert = db.prepare("INSERT INTO budget (provider, cents) VALUES (?, ?)");
  for (let i = 0; i < 500; i += 1) insert.run(`provider-${i}`, i * 7);
  db.close();
}

/** Tiny in-memory S3 so the full flow runs with no network and no credential. */
function makeS3Stub({ corruptOnGet = false } = {}) {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const parsed = new URL(url);
    const [, , ...keyParts] = parsed.pathname.split("/");
    const key = keyParts.join("/");
    calls.push({ method, key: key || "(list)" });

    if (method === "PUT") {
      store.set(key, Buffer.from(init.body));
      return { ok: true, status: 200, async text() { return ""; } };
    }
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const contents = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, v]) =>
            `<Contents><Key>${k}</Key><Size>${v.length}</Size>` +
            `<LastModified>2026-08-12T00:00:00.000Z</LastModified></Contents>`
        )
        .join("");
      const xml = `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
      return { ok: true, status: 200, async text() { return xml; } };
    }
    if (method === "GET") {
      const stored = store.get(key);
      if (!stored) return { ok: false, status: 404, async text() { return "<Error/>"; } };
      const body = corruptOnGet ? Buffer.concat([stored, Buffer.from("x")]) : stored;
      return {
        ok: true,
        status: 200,
        // Real fetch exposes a web ReadableStream; the archiver streams it.
        body: new Response(body).body,
        async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.length); },
        async text() { return ""; },
      };
    }
    if (method === "DELETE") {
      store.delete(key);
      return { ok: true, status: 204, async text() { return ""; } };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, store, calls };
}

function baseEnv(dir, dbPath) {
  return {
    R2_ARCHIVE_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_ARCHIVE_ACCESS_KEY_ID: "test-key",
    R2_ARCHIVE_SECRET_ACCESS_KEY: "test-secret",
    R2_ARCHIVE_BUCKET: "usage-monitor-prod-v3",
    R2_ARCHIVE_DB_PATH: dbPath,
    R2_ARCHIVE_STATUS_PATH: join(dir, "status.json"),
  };
}

await test("runArchive uploads a verifiable, restorable snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub();

    const result = await runArchive({ env: baseEnv(dir, dbPath), argv: [], fetchImpl: s3.fetchImpl });

    assert.equal(result.ok, true);
    assert.match(result.key, /^weekly\/prod-.*\.db\.gz$/);
    assert.equal(s3.store.size, 1);

    // The stored bytes really are a gzipped, openable SQLite database.
    const restored = join(dir, "restored.db");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(restored, gunzipSync(s3.store.get(result.key)));
    const db = new DatabaseSync(restored, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM budget").get();
    db.close();
    assert.equal(row.n, 500, "restored archive must contain the source rows");

    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    assert.equal(status.ok, true);
    assert.equal(status.key, result.key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("runArchive prunes only after verification, honouring the keep count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub();
    // Three pre-existing generations plus an unrelated litestream object.
    s3.store.set("weekly/prod-2026-07-22T00-00-00Z.db.gz", Buffer.from("old-1"));
    s3.store.set("weekly/prod-2026-07-29T00-00-00Z.db.gz", Buffer.from("old-2"));
    s3.store.set("weekly/prod-2026-08-05T00-00-00Z.db.gz", Buffer.from("old-3"));
    s3.store.set("api-usage-monitor/prod.db/0001/0000.ltx", Buffer.from("litestream"));

    const result = await runArchive({
      env: baseEnv(dir, dbPath),
      argv: ["--keep", "2"],
      fetchImpl: s3.fetchImpl,
    });

    assert.equal(result.pruned.length, 2);
    assert.ok(s3.store.has(result.key), "fresh upload retained");
    assert.ok(s3.store.has("weekly/prod-2026-08-05T00-00-00Z.db.gz"), "newest old generation retained");
    assert.ok(!s3.store.has("weekly/prod-2026-07-29T00-00-00Z.db.gz"));
    assert.ok(!s3.store.has("weekly/prod-2026-07-22T00-00-00Z.db.gz"));
    assert.ok(
      s3.store.has("api-usage-monitor/prod.db/0001/0000.ltx"),
      "the frozen litestream history must never be touched"
    );

    // Ordering is the safety contract: no DELETE may precede the verifying GET.
    const firstDelete = s3.calls.findIndex((c) => c.method === "DELETE");
    const verifyGet = s3.calls.findIndex((c) => c.method === "GET" && c.key === result.key);
    assert.ok(verifyGet !== -1, "verification GET must happen");
    assert.ok(firstDelete > verifyGet, "no deletion may happen before verification");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a corrupted upload aborts the run and deletes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub({ corruptOnGet: true });
    s3.store.set("weekly/prod-2026-08-05T00-00-00Z.db.gz", Buffer.from("precious-old-backup"));

    await assert.rejects(
      runArchive({ env: baseEnv(dir, dbPath), argv: ["--keep", "1"], fetchImpl: s3.fetchImpl }),
      /hash mismatch/
    );

    assert.ok(
      s3.store.has("weekly/prod-2026-08-05T00-00-00Z.db.gz"),
      "the previous archive survives a failed verification"
    );
    assert.equal(s3.calls.filter((c) => c.method === "DELETE").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("missing credentials fail closed with actionable guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    await assert.rejects(
      runArchive({ env: { R2_ARCHIVE_DB_PATH: dbPath }, argv: [] }),
      /missing R2 archive credentials.*R2_ARCHIVE_ENDPOINT/s
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the R2 kill switch blocks the archive unless explicitly overridden", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const env = { ...baseEnv(dir, dbPath), R2_WRITES_DISABLED: "true" };
    await assert.rejects(runArchive({ env, argv: [] }), /kill switch is engaged/);

    const s3 = makeS3Stub();
    const result = await runArchive({
      env: { ...env, R2_ARCHIVE_IGNORE_KILL_SWITCH: "true" },
      argv: [],
      fetchImpl: s3.fetchImpl,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("dry run uploads nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub();
    const result = await runArchive({
      env: baseEnv(dir, dbPath),
      argv: ["--dry-run"],
      fetchImpl: s3.fetchImpl,
    });
    assert.equal(result.dryRun, true);
    assert.equal(s3.store.size, 0);
    assert.equal(s3.calls.length, 0);
    assert.ok(!existsSync(join(dir, "status.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
