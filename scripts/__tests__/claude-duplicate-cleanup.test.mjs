import test from "node:test";
import assert from "node:assert/strict";
import { planClaudeDuplicateLines, finalizeClaudeDuplicateCandidates } from "../lib/claude-duplicate-cleanup.mjs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const row = (id, output = 20, timestamp = "2026-10-29T12:00:00Z") => ({ timestamp,
  message: { id, model: "claude-test", usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 } } });
const text = (...rows) => rows.map(JSON.stringify).join("\n");

test("identical message repeated by content block identifies exact old event IDs", () => {
  const result = planClaudeDuplicateLines(text(row("call-a"), row("call-a")), { sessionKey: "projects/test/session.jsonl" });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.ambiguousMessages, 0);
  assert.equal(result.candidates.reduce((sum, value) => sum + value.quantity, 0), 30);
  assert.ok(result.candidates.every((candidate) => candidate.eventId !== candidate.keeperEventId));
});
test("same timestamp or usage alone never proves duplication", () => {
  assert.equal(planClaudeDuplicateLines(text(row("call-a"), row("call-b")), { sessionKey: "session" }).candidates.length, 0);
});
test("changed usage for the same message fails closed", () => {
  const result = planClaudeDuplicateLines(text(row("call-a"), row("call-a", 21)), { sessionKey: "session" });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.ambiguousMessages, 1);
});
test("a later inconsistent block invalidates previously collected candidates", () => {
  const result = planClaudeDuplicateLines(text(row("call-a"), row("call-a"), row("call-a", 21), row("call-a")), { sessionKey: "session" });
  assert.equal(result.candidates.length, 0);
});
test("missing message ID and invalid timestamp never create candidates", () => {
  assert.equal(planClaudeDuplicateLines(text(row(undefined), row(undefined)), { sessionKey: "session" }).candidates.length, 0);
  assert.equal(planClaudeDuplicateLines(text(row("a", 20, "invalid"), row("a")), { sessionKey: "session" }).candidates.length, 0);
});
test("cross-file repeats use explicit shared message identity", () => {
  const seen = new Map();
  planClaudeDuplicateLines(text(row("call-a")), { sessionKey: "first", seen });
  const result = planClaudeDuplicateLines(text(row("call-a")), { sessionKey: "second", seen });
  assert.equal(result.candidates.length, 2);
});
test("a later inconsistent transcript invalidates earlier file candidates", () => {
  const seen = new Map();
  const first = planClaudeDuplicateLines(text(row("call-a"), row("call-a")), { sessionKey: "first", seen });
  assert.equal(first.candidates.length, 2);
  planClaudeDuplicateLines(text(row("call-a", 21)), { sessionKey: "later", seen });
  assert.equal(finalizeClaudeDuplicateCandidates(first.candidates, seen).length, 0);
});
test("malformed model values use the historical collector fallback without crashing", () => {
  const malformed = row("call-a"); malformed.message.model = 42;
  const result = planClaudeDuplicateLines(text(malformed, malformed), { sessionKey: "session" });
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.model === "claude-3-7-sonnet"));
});
test("streaming CLI preserves line IDs, UTF-8 boundaries and exact source hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-stream-proof-"));
  try {
    await mkdir(join(directory, "projects", "test"), { recursive: true });
    const source = text({ padding: "😀".repeat(20_000) }, row("call-a"), row("call-a"));
    const sourcePath = join(directory, "projects", "test", "session.jsonl");
    const manifestPath = join(directory, "proof.json");
    await writeFile(sourcePath, source);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../plan-claude-duplicate-cleanup.mjs", import.meta.url)), "--claude-home", directory, "--manifest", manifestPath, "--since", "2000-01-01T00:00:00Z"], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const expected = planClaudeDuplicateLines(source, { sessionKey: "projects/test/session.jsonl" });
    assert.deepEqual(manifest.candidates.map((candidate) => candidate.eventId), expected.candidates.map((candidate) => candidate.eventId));
    assert.ok(manifest.candidates.every((candidate) => candidate.sourceProofHash === createHash("sha256").update(source).digest("hex") && candidate.keeperSourceProofHash === candidate.sourceProofHash));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
