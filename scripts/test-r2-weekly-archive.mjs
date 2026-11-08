#!/usr/bin/env node
/**
 * Tests for the weekly R2 archive and its SigV4 signer.
 *
 * Runs standalone (no vitest) to match the other deploy-critical script tests
 * in this repo, and uses an in-memory S3 stub so the whole upload → verify →
 * prune flow is exercised without touching a real bucket or a credential.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import { awsUriEncode, signS3Request, s3Request } from "./lib/s3-sigv4.mjs";
import {
  archiveKeyFor,
  archiveKeyTimeMs,
  classifyFailure,
  isManagedArchiveKey,
  resolveArchiveConfig,
  runArchive,
  selectPruneTargets,
  uploadMultipart,
} from "./ops/r2-weekly-archive.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
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

await test("selectPruneTargets never keeps an archive more than 14 days older than the fresh one", () => {
  // Jay 2026-10-30: the 2 weeks counts from day 1. Two failed weeks in a row
  // left the previous good copy 21 days old; keep=2 alone would keep it.
  const objects = [
    { key: "weekly/prod-2026-07-22T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-12T00-00-00Z.db.gz" },
  ];
  const fresh = "weekly/prod-2026-08-12T00-00-00Z.db.gz";
  assert.deepEqual(selectPruneTargets(objects, fresh, 2), ["weekly/prod-2026-07-22T00-00-00Z.db.gz"]);

  // A raised keep (R2_ARCHIVE_KEEP_GENERATIONS=4) is capped too; exactly 14 days stays.
  const weekly = [
    { key: "weekly/prod-2026-07-22T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-07-29T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-05T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-12T00-00-00Z.db.gz" },
  ];
  assert.deepEqual(selectPruneTargets(weekly, fresh, 4), ["weekly/prod-2026-07-22T00-00-00Z.db.gz"]);

  // Run-time jitter: 14 days + 1 second is over the cap.
  const jitter = [
    { key: "weekly/prod-2026-07-29T00-00-00Z.db.gz" },
    { key: "weekly/prod-2026-08-12T00-00-01Z.db.gz" },
  ];
  assert.deepEqual(selectPruneTargets(jitter, "weekly/prod-2026-08-12T00-00-01Z.db.gz", 2), [
    "weekly/prod-2026-07-29T00-00-00Z.db.gz",
  ]);

  // The normal weekly shape is untouched: fresh + the 7-day-old copy.
  assert.deepEqual(selectPruneTargets(weekly.slice(2), fresh, 2), []);
});

await test("archiveKeyTimeMs parses the key stamp", () => {
  assert.equal(
    archiveKeyTimeMs("weekly/prod-2026-08-12T09-48-45Z.db.gz"),
    Date.parse("2026-08-12T09:48:45Z")
  );
  assert.ok(Number.isNaN(archiveKeyTimeMs("weekly/README.txt")));
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

await test("S3 transport failures retain operation and bounded nested cause codes", async () => {
  for (const [method, reason] of [["PUT", "upload_failed"], ["GET", "download_failed"], ["DELETE", "prune_failed"]]) {
    let calls = 0;
    await assert.rejects(s3Request({
      method,
      creds: { endpoint: "https://fixture.invalid", accessKeyId: "fixture", secretAccessKey: "fixture" },
      bucket: "fixture",
      fetchImpl: async () => {
        calls++;
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("private socket detail"), { code: "ECONNRESET" }) });
      },
    }), (error) => {
      assert.equal(error.message, `S3 ${method} transport failed (ECONNRESET)`);
      assert.equal(classifyFailure(error), reason);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1, "diagnostics must not retry the request");
  }
});

await test("S3 transport diagnostics exclude arbitrary messages, codes and credentials", async () => {
  const privateDetail = "private-secret https://private.invalid/?token=private-secret";
  const hostile = Object.assign(new Error(privateDetail), { code: privateDetail });
  hostile.cause = hostile;
  await assert.rejects(s3Request({
    method: "PUT",
    creds: { endpoint: "https://fixture.invalid", accessKeyId: "private-key", secretAccessKey: "private-secret" },
    bucket: "private-bucket",
    key: "private-object",
    fetchImpl: async () => { throw hostile; },
  }), (error) => {
    assert.equal(error.message, "S3 PUT transport failed (unknown)");
    assert.doesNotMatch(error.stack, /private-|token=/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

// ------------------------------------------------------------ multipart ----

const STUB_CREDS = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
};

await test("uploadMultipart assembles sequential parts into one object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const filePath = join(dir, "payload.bin");
    const payload = Buffer.alloc(2500);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    writeFileSync(filePath, payload);
    const s3 = makeS3Stub();

    const { partCount } = await uploadMultipart({
      creds: STUB_CREDS,
      bucket: "usage-monitor-prod-v3",
      key: "weekly/test.db.gz",
      filePath,
      fileBytes: payload.length,
      fetchImpl: s3.fetchImpl,
      partBytes: 1000,
    });

    assert.equal(partCount, 3, "2500 bytes at 1000-byte parts is 3 parts");
    assert.deepEqual(s3.store.get("weekly/test.db.gz"), payload);
    assert.deepEqual(
      s3.calls.map((c) => c.method),
      ["POST", "PUT", "PUT", "PUT", "POST"],
      "create, three parts, complete"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("uploadMultipart retries a part whose connection drops, then completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const filePath = join(dir, "payload.bin");
    const payload = Buffer.from("one part, dropped once");
    writeFileSync(filePath, payload);
    const s3 = makeS3Stub();
    let putAttempts = 0;

    const result = await uploadMultipart({
      creds: STUB_CREDS,
      bucket: "usage-monitor-prod-v3",
      key: "weekly/test.db.gz",
      filePath,
      fileBytes: payload.length,
      fetchImpl: async (url, init) => {
        if (init.method === "PUT") {
          putAttempts += 1;
          if (putAttempts === 1) {
            // The 2026-11-07 live failure: the socket dies mid-transfer.
            throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
          }
        }
        return s3.fetchImpl(url, init);
      },
    });

    assert.equal(result.partCount, 1);
    assert.equal(putAttempts, 2, "the dropped part is retried, not the whole upload");
    assert.deepEqual(s3.store.get("weekly/test.db.gz"), payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("uploadMultipart aborts and preserves the signer error when a part never lands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const filePath = join(dir, "payload.bin");
    writeFileSync(filePath, Buffer.from("never lands"));
    const s3 = makeS3Stub();

    await assert.rejects(
      uploadMultipart({
        creds: STUB_CREDS,
        bucket: "usage-monitor-prod-v3",
        key: "weekly/test.db.gz",
        filePath,
        fileBytes: 11,
        fetchImpl: async (url, init) => {
          if (init.method === "PUT") {
            throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
          }
          return s3.fetchImpl(url, init);
        },
      }),
      (error) => {
        assert.equal(error.message, "S3 PUT transport failed (ECONNRESET)");
        assert.equal(classifyFailure(error), "upload_failed");
        return true;
      }
    );
    assert.equal(s3.uploads.size, 0, "abort removes the in-flight upload");
    assert.equal(s3.store.size, 0, "no object is created from a failed upload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("uploadMultipart rejects non-positive part geometry before any S3 call", async () => {
  const s3 = makeS3Stub();
  await assert.rejects(
    uploadMultipart({
      creds: STUB_CREDS,
      bucket: "usage-monitor-prod-v3",
      key: "weekly/test.db.gz",
      filePath: "/nonexistent",
      fileBytes: 10,
      fetchImpl: s3.fetchImpl,
      partBytes: 0,
    }),
    /partBytes must be a positive integer/
  );
  await assert.rejects(
    uploadMultipart({
      creds: STUB_CREDS,
      bucket: "usage-monitor-prod-v3",
      key: "weekly/test.db.gz",
      filePath: "/nonexistent",
      fileBytes: -1,
      fetchImpl: s3.fetchImpl,
    }),
    /fileBytes must be a non-negative integer/
  );
  assert.equal(s3.calls.length, 0, "validation happens before CreateMultipartUpload");
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
  const uploads = new Map();
  const calls = [];
  let uploadSeq = 0;
  const respond = (status, textBody, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() { return textBody; },
  });
  const fetchImpl = async (url, init) => {
    const method = init.method;
    const parsed = new URL(url);
    const [, , ...keyParts] = parsed.pathname.split("/");
    const key = keyParts.join("/");
    calls.push({ method, key: key || "(list)" });

    // CreateMultipartUpload — POST with ?uploads and no uploadId yet.
    if (method === "POST" && parsed.searchParams.has("uploads")) {
      uploadSeq += 1;
      const uploadId = `stub-upload-${uploadSeq}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return respond(
        200,
        `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>stub</Bucket>` +
          `<Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
      );
    }
    // CompleteMultipartUpload — assemble the parts in part-number order.
    if (method === "POST" && parsed.searchParams.get("uploadId")) {
      const uploadId = parsed.searchParams.get("uploadId");
      const upload = uploads.get(uploadId);
      if (!upload) return respond(404, "<Error><Code>NoSuchUpload</Code></Error>");
      const assembled = Buffer.concat(
        [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, body]) => body)
      );
      store.set(upload.key, assembled);
      uploads.delete(uploadId);
      return respond(
        200,
        `<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${upload.key}</Key></CompleteMultipartUploadResult>`
      );
    }
    if (method === "PUT") {
      const partNumber = parsed.searchParams.get("partNumber");
      if (partNumber !== null) {
        const upload = uploads.get(parsed.searchParams.get("uploadId"));
        if (!upload) return respond(404, "<Error><Code>NoSuchUpload</Code></Error>");
        upload.parts.set(Number(partNumber), Buffer.from(init.body));
        return respond(200, "", { etag: `"stub-etag-${partNumber}"` });
      }
      store.set(key, Buffer.from(init.body));
      return respond(200, "", { etag: '"stub-etag"' });
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
      return respond(200, xml);
    }
    if (method === "GET") {
      const stored = store.get(key);
      if (!stored) return respond(404, "<Error/>");
      const body = corruptOnGet ? Buffer.concat([stored, Buffer.from("x")]) : stored;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        // Real fetch exposes a web ReadableStream; the archiver streams it.
        body: new Response(body).body,
        async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.length); },
        async text() { return ""; },
      };
    }
    if (method === "DELETE") {
      const uploadId = parsed.searchParams.get("uploadId");
      if (uploadId) {
        // AbortMultipartUpload — the parts vanish, no object is created.
        uploads.delete(uploadId);
        return respond(204, "");
      }
      store.delete(key);
      return respond(204, "");
    }
    throw new Error(`unexpected ${method}`);
  };
  return { fetchImpl, store, calls, uploads };
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
    // Three pre-existing generations (all inside the 14-day cap, relative to
    // the real clock the fresh key uses) plus an unrelated litestream object.
    const old1 = archiveKeyFor("weekly/", new Date(Date.now() - 9 * DAY_MS));
    const old2 = archiveKeyFor("weekly/", new Date(Date.now() - 8 * DAY_MS));
    const old3 = archiveKeyFor("weekly/", new Date(Date.now() - 7 * DAY_MS));
    s3.store.set(old1, Buffer.from("old-1"));
    s3.store.set(old2, Buffer.from("old-2"));
    s3.store.set(old3, Buffer.from("old-3"));
    s3.store.set("api-usage-monitor/prod.db/0001/0000.ltx", Buffer.from("litestream"));

    const result = await runArchive({
      env: baseEnv(dir, dbPath),
      argv: ["--keep", "2"],
      fetchImpl: s3.fetchImpl,
    });

    assert.equal(result.pruned.length, 2);
    assert.ok(s3.store.has(result.key), "fresh upload retained");
    assert.ok(s3.store.has(old3), "newest old generation retained");
    assert.ok(!s3.store.has(old2));
    assert.ok(!s3.store.has(old1));
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

await test("runArchive applies the 14-day cap even when --keep would retain more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub();
    const stale = archiveKeyFor("weekly/", new Date(Date.now() - 20 * DAY_MS));
    const lastWeek = archiveKeyFor("weekly/", new Date(Date.now() - 7 * DAY_MS));
    s3.store.set(stale, Buffer.from("stale"));
    s3.store.set(lastWeek, Buffer.from("last-week"));

    const result = await runArchive({
      env: baseEnv(dir, dbPath),
      argv: ["--keep", "4"],
      fetchImpl: s3.fetchImpl,
    });

    assert.deepEqual(result.pruned, [stale]);
    assert.ok(s3.store.has(result.key), "fresh upload retained");
    assert.ok(s3.store.has(lastWeek), "7-day-old copy retained");
    assert.ok(!s3.store.has(stale), "20-day-old copy pruned by the 14-day cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("an upload transport rejection reports its phase and never verifies or prunes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-archive-test-"));
  try {
    const dbPath = join(dir, "prod.db");
    makeDatabase(dbPath);
    const s3 = makeS3Stub();
    const oldKey = archiveKeyFor("weekly/", new Date(Date.now() - 20 * DAY_MS));
    s3.store.set(oldKey, Buffer.from("old-archive"));
    const methods = [];
    await assert.rejects(runArchive({
      env: baseEnv(dir, dbPath),
      argv: [],
      fetchImpl: async (url, init) => {
        methods.push(init.method);
        if (init.method === "PUT") {
          throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
        }
        return s3.fetchImpl(url, init);
      },
    }), (error) => {
      assert.equal(error.message, "S3 PUT transport failed (UND_ERR_HEADERS_TIMEOUT)");
      assert.equal(classifyFailure(error), "upload_failed");
      return true;
    });
    // Create, the part's three attempts (the per-part retry budget), then the
    // abort — and nothing else: a failed upload never verifies or prunes.
    assert.deepEqual(methods, ["POST", "PUT", "PUT", "PUT", "DELETE"]);
    assert.equal(s3.uploads.size, 0, "the aborted upload leaves nothing behind");
    assert.deepEqual([...s3.store.keys()], [oldKey]);
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
