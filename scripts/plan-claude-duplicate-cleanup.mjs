import { readdir, readFile, stat, open } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { deriveUsageTelemetryV2IdempotencyKey } from "@jaywedgeworth22/congress-trading-shared";
import { planClaudeDuplicateLines, finalizeClaudeDuplicateCandidates } from "./lib/claude-duplicate-cleanup.mjs";

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
const stamped = await Promise.all((await walk(join(resolve(root), "projects"))).map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })));
for (const { path, mtime } of stamped.sort((left, right) => left.mtime - right.mtime)) {
  if (mtime < since.getTime()) continue;
  const raw = await readFile(path, "utf8");
  const sessionKey = relative(resolve(root), path).replaceAll("\\", "/");
  const sourceProofHash = createHash("sha256").update(raw).digest("hex");
  const plan = planClaudeDuplicateLines(raw, { sessionKey, seen, sourceProofHash });
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
