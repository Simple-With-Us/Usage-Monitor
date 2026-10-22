// The App Store Connect private key:  how it is validated, how it is staged
// for the Apple tools that need a key on disk, and what a child process is
// allowed to inherit.
//
// AFC-459:  the private key is a secret, and the approved secret sources are
// the process environment, a captured `fleet-secrets get NAME` and
// bootstrap-only Keychain credentials.  A caller-supplied file is not one of
// them, so this module never reads a key file:  the only approved sources of
// the key are ASC_KEY_P8 in the environment and `fleet-secrets get ASC_KEY_P8`.
// ASC_KEY_PATH is not a credential source at all, and the tests below hold the
// module and the client to that.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as keyModule from "./asc-key.mjs";
import { normalizePrivateKey, writePrivateKeyFile } from "./asc-key.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "asc-key.mjs");
const client = join(here, "asc-api.mjs");
const root = mkdtempSync(join(tmpdir(), "asc-key-test-"));
//  A PATH with node and nothing else:  the fleet reader lives in the operator's
//  own bin directory, and a test must never reach it or Infisical.
const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

function generateKeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

// A fingerprint of the key material.  The test compares fingerprints, so the
// key itself never travels through an assertion or a message.
function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Reads a file once and reports its mode and its contents together.  Asking
// for the mode and then reading the path separately leaves a gap in which the
// file can be swapped for another one, so the descriptor does both.
function readOnce(path) {
  const fd = openSync(path, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, content: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

const keyPem = generateKeyPair().privateKey.export({ type: "pkcs8", format: "pem" });

function staged(name, content = keyPem, mode = 0o600) {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

function run(args, stdin = "", env = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], {
      ...(env ? { env } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function spawnNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A local server that answers one request, so the client can be watched
// signing it.  It never sees anything but the test's own synthetic key.
function localServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => server.close()
    }));
  });
}

// Tells whether a bearer token was signed with a given key pair.
function signedWith(authorization, publicKey) {
  const token = String(authorization || "").replace(/^Bearer /, "");
  if (!token) return false;
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return false;
  try {
    const verifier = createVerify("SHA256");
    verifier.update(`${header}.${payload}`);
    return verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

test("the module exports exactly the four helpers and holds no file reader", () => {
  //  The module is the revision-2 shape:  it validates a key, it writes a
  //  staging copy for the Apple tools, and it builds the environment a child
  //  is allowed to inherit.  A reader, an exec helper or a read/exec
  //  subcommand would mean a path on disk had become a credential source
  //  again, which is the finding this port closes.
  assert.deepEqual(Object.keys(keyModule).sort(),
    ["CLIENT_ENV_ALLOWLIST", "clientEnvironment", "normalizePrivateKey", "writePrivateKeyFile"].sort());
  const source = readFileSync(helper, "utf8");
  assert.doesNotMatch(source, /readPrivateKeyFile/, "the module has a key reader again");
  assert.doesNotMatch(source, /execWithKey/, "the module has an exec helper again");
  assert.doesNotMatch(source, /O_NOFOLLOW/, "the module hardens a file read again");
  assert.doesNotMatch(source, /readFileSync|createReadStream/, "the module reads a file again");
});

test("a generated key is accepted and comes back with a trailing newline", () => {
  const normalized = normalizePrivateKey(keyPem);
  assert.ok(normalized, "a real key was refused");
  assert.ok(normalized.endsWith("\n"), "the key has to end with a newline");
  assert.equal(fingerprint(normalized.trim()), fingerprint(keyPem.trim()));
});

test("a malformed PEM is refused, because the envelope is not a key", () => {
  //  A truncated key, an armored block and a mangled export all carry the
  //  envelope and still fail to parse.  Accepting them would hand the signer
  //  something it cannot use, and the failure would come back as a stack
  //  trace instead of a credential error.
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey(""), null);
  assert.equal(normalizePrivateKey(undefined), null);
  assert.equal(normalizePrivateKey("hunter2"), null);
});

test("the staging copy is written for its owner only", () => {
  const path = join(root, "written.p8");
  const written = writePrivateKeyFile(path, keyPem);
  assert.ok(written.pem, `the key was not written: ${written.error}`);
  const read = readOnce(path);
  assert.equal(read.mode, 0o600, "the staging copy is not owner-only");
  assert.equal(fingerprint(read.content.trim()), fingerprint(keyPem.trim()));
});

test("a value that is not a key is refused, and no file is written", () => {
  const path = join(root, "refused.p8");
  const written = writePrivateKeyFile(path, "not a private key");
  assert.match(written.error || "", /not a PEM private key/);
  assert.equal(written.pem, undefined, "a refused value came back as a key");
});

test("the child's environment is an allowlist, not a copy of the parent's", () => {
  //  A wholesale copy hands every credential on the operator's machine to the
  //  child, including the ones that have nothing to do with App Store
  //  Connect.
  const child = keyModule.clientEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_P8: keyPem,
    SENTRY_AUTH_TOKEN: "a credential of no business here",
    AWS_SECRET_ACCESS_KEY: "another credential of no business here"
  });
  assert.equal(child.ASC_KEY_ID, "SYNTHETICKEYID1");
  assert.equal(child.ASC_ISSUER_ID, "synthetic-issuer");
  assert.equal(child.SENTRY_AUTH_TOKEN, undefined, "an unrelated credential crossed over");
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined, "an unrelated credential crossed over");
  assert.equal(child.ASC_KEY_P8, undefined, "the key is not on the allowlist");
});

test("the allowlist names the variables the client reads and not the key itself", () => {
  const allowlist = keyModule.CLIENT_ENV_ALLOWLIST;
  for (const name of ["ASC_KEY_ID", "ASC_ISSUER_ID", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID",
    "APPLE_API_KEY_P8_BASE64", "PATH", "HOME"]) {
    assert.ok(allowlist.includes(name), `${name} is not on the allowlist`);
  }
  assert.ok(!allowlist.includes("ASC_KEY_P8"), "the key itself is on the allowlist");
  assert.ok(!allowlist.includes("ASC_KEY_PATH"), "a path is on the allowlist");
});

test("the command line reports the status of a key and never prints it", async () => {
  //  A key on stdout is a key in every log that captures it, so the command
  //  reports whether the value is usable and nothing else.
  const ok = await run(["validate"], keyPem);
  assert.equal(ok.code, 0, `the key was refused: ${ok.stderr}`);
  assert.match(ok.stdout, /is a PEM private key/, `the status was not reported:\n${ok.stdout}`);
  assert.doesNotMatch(ok.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.doesNotMatch(ok.stderr, /PRIVATE KEY/, "the key reached stderr");

  const bad = await run(["validate"], "not a private key");
  assert.equal(bad.code, 1, "a value that is not a key was accepted");
  assert.match(bad.stderr, /not a PEM private key/);
  assert.equal(bad.stdout, "", "a refused value must not put anything on stdout");
});

test("the command line writes a key to a file only its owner can read", async () => {
  const path = join(root, "cli-written.p8");
  const result = await run(["write", path], keyPem);
  assert.equal(result.code, 0, `the write failed: ${result.stderr}`);
  const read = readOnce(path);
  assert.equal(read.mode, 0o600);
  assert.equal(fingerprint(read.content.trim()), fingerprint(keyPem.trim()));

  const refused = await run(["write", join(root, "cli-refused.p8")], "not a private key");
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /not a PEM private key/);
});

test("the command line has no read and no exec subcommand", async () => {
  //  A path on disk is not an approved credential source, so there is no
  //  command that reads a key out of a file and none that runs a child with
  //  one.  Both were the revision-1 shape.
  const path = staged("no-subcommand.p8");
  for (const args of [["read", path], ["exec", path, "--", process.execPath, "-e", "process.stdout.write('ran')"]]) {
    const result = await run(args);
    assert.equal(result.code, 1, `${args[0]} must not be a command`);
    assert.match(result.stderr, /usage: asc-key\.mjs validate \| write <path>/);
    assert.equal(result.stdout, "", `${args[0]} ran something`);
  }
});

test("the client ignores a named ASC_KEY_PATH", async () => {
  //  The named path holds a perfectly good key, and the client still refuses
  //  it:  a path is not a credential source, so the run has to say which
  //  input was wrong instead of quietly signing with whatever the path
  //  pointed at.
  const home = join(root, "home-ignored");
  mkdirSync(home, { recursive: true });
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: home,
    FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
    FLEET_SECRETS: join(root, "no-fleet-secrets"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_PATH: staged("ignored.p8")
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
  assert.match(result.stderr, /A path in ASC_KEY_PATH is not a credential source/);
  assert.doesNotMatch(result.stderr, /using ASC_KEY_PATH/);
});

test("the environment wins over a named file", async () => {
  //  The named file holds one key and the environment holds another.  The
  //  request has to be signed with the environment's key, and the signature
  //  is checked against the public halves of both keys, so "the environment
  //  won" is a fact about the bytes on the wire and not about a log line.
  const envPair = generateKeyPair();
  const filePair = generateKeyPair();
  const envPem = envPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const filePem = filePair.privateKey.export({ type: "pkcs8", format: "pem" });
  const home = join(root, "home-wins");
  mkdirSync(home, { recursive: true });
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: home,
      FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
      FLEET_SECRETS: join(root, "no-fleet-secrets"),
      ASC_KEY_ID: "SYNTHETICKEYID1",
      ASC_ISSUER_ID: "synthetic-issuer",
      ASC_KEY_P8: envPem,
      ASC_KEY_PATH: staged("named.p8", filePem)
    });
    assert.equal(result.code, 0, `the client did not run: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not report the environment source:\n${result.stderr}`);
    assert.equal(server.seen.length, 1, "the client never reached the server");
    const authorization = server.seen[0].authorization;
    assert.ok(signedWith(authorization, envPair.publicKey),
      "the request was not signed with the key from the environment");
    assert.ok(!signedWith(authorization, filePair.publicKey),
      "the request was signed with the key from the named file");
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/, "the key reached the output");
  } finally {
    server.close();
  }
});

test("the client refuses a key in the environment that is not a private key", async () => {
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: join(root, "home-bad"),
    FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
    FLEET_SECRETS: join(root, "no-fleet-secrets"),
    ASC_KEY_ID: "SYNTHETICKEYID1",
    ASC_ISSUER_ID: "synthetic-issuer",
    ASC_KEY_P8: "this is not a private key"
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /ASC_KEY_P8 is set but is not a PEM private key/);
});

test("the hosted base64 trio is the credential the client signs with", async () => {
  //  This is the hosted runner's path end to end:  the workflow publishes the
  //  key id, the issuer and the base64 body of the key, the client takes
  //  them from the environment, and the request is signed with that key.
  //  The named file is ignored, so it cannot be what signed the request.
  const hostedPair = generateKeyPair();
  const hostedPem = hostedPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const filePair = generateKeyPair();
  const filePem = filePair.privateKey.export({ type: "pkcs8", format: "pem" });
  const home = join(root, "home-hosted");
  mkdirSync(home, { recursive: true });
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: home,
      FLEET_SECRETS_BIN: join(root, "no-fleet-secrets"),
      FLEET_SECRETS: join(root, "no-fleet-secrets"),
      APPLE_API_KEY_ID: "HOSTEDKEYID1",
      APPLE_API_ISSUER_ID: "hosted-issuer",
      APPLE_API_KEY_P8_BASE64: Buffer.from(hostedPem, "utf8").toString("base64"),
      ASC_KEY_PATH: staged("hosted-named.p8", filePem)
    });
    assert.equal(result.code, 0, `the client did not run: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using APPLE_API_\* environment/,
      `the client did not report the hosted source:\n${result.stderr}`);
    assert.equal(server.seen.length, 1, "the client never reached the server");
    const authorization = server.seen[0].authorization;
    assert.ok(signedWith(authorization, hostedPair.publicKey),
      "the request was not signed with the hosted key");
    assert.ok(!signedWith(authorization, filePair.publicKey),
      "the request was signed with the key from the named file");
  } finally {
    server.close();
  }
});
