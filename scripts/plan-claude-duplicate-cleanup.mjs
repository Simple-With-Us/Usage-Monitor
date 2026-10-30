import { readdir, stat, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { deriveUsageTelemetryV2IdempotencyKey } from "@jaywedgeworth22/congress-trading-shared";
import { createClaudeDuplicateLinePlanner, finalizeClaudeDuplicateCandidates } from "./lib/claude-duplicate-cleanup.mjs";

async function main() {
const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const root = option("--claude-home");
const output = option("--manifest");
const sinceRaw = option("--since");
if (!root || !output || !sinceRaw) throw new Error("Explicit --claude-home, --manifest, --since required");
const since = new Date(sinceRaw);
if (!Number.isFinite(since.getTime())) throw new Error("Invalid --since");
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && path.endsWith(".jsonl")) files.push(path);
  }
  return files;
}
let candidates = [];
const seen = new Map();
let scannedFiles = 0, ambiguousMessages = 0;
const stamped = [];
for (const path of await walk(join(resolve(root), "projects"))) stamped.push({ path, mtime: (await stat(path)).mtimeMs });
for (const { path, mtime } of stamped.sort((left, right) => left.mtime - right.mtime)) {
  if (mtime < since.getTime()) continue;
  const sessionKey = relative(resolve(root), path).replaceAll("\\", "/");
  const planner = createClaudeDuplicateLinePlanner({ sessionKey, seen });
  const hash = createHash("sha256"), decoder = new StringDecoder("utf8");
  let pending = "", line = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    hash.update(chunk);
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      if (Buffer.byteLength(pending.slice(0, end)) > 64 * 1024 * 1024) throw new Error("Transcript line limit exceeded");
      planner.addLine(pending.slice(0, end), line++);
      pending = pending.slice(end + 1);
    }
    if (Buffer.byteLength(pending) > 64 * 1024 * 1024) throw new Error("Transcript line limit exceeded");
  }
  pending += decoder.end();
  planner.addLine(pending, line);
  const sourceProofHash = hash.digest("hex");
  const plan = planner.finish(sourceProofHash);
  scannedFiles++;
  ambiguousMessages += plan.ambiguousMessages;
  for (const candidate of plan.candidates) {
    if (new Date(candidate.occurredAt).getTime() < since.getTime()) continue;
    candidates.push({ ...candidate,
      sourceProofHash,
      idempotencyKey: await deriveUsageTelemetryV2IdempotencyKey({ producerId: "claude-code", eventId: candidate.eventId }),
      keeperIdempotencyKey: await deriveUsageTelemetryV2IdempotencyKey({ producerId: "claude-code", eventId: candidate.keeperEventId }),
    });
  }
}
candidates = finalizeClaudeDuplicateCandidates(candidates, seen);
const totals = {};
for (const candidate of candidates) totals[candidate.label] = (totals[candidate.label] || 0) + candidate.quantity;
const manifest = { version: 1, mode: "proof-only-no-database-mutation", scannedFiles, ambiguousMessages, totals, candidates };
const handle = await open(output, "wx", 0o600);
try { await handle.writeFile(JSON.stringify(manifest)); } finally { await handle.close(); }
console.log(JSON.stringify({ scannedFiles, ambiguousMessages, candidates: candidates.length, totals,
  manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") }));
}

main().catch((error) => {
  const errorName = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.name ?? "") ? error.name : "Error";
  console.error(JSON.stringify({ phase: "cleanup-source-plan", errorName }));
  process.exitCode = 1;
});
