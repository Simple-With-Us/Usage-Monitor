import { createHash } from "node:crypto";
import { CLAUDE_PRODUCER_ID, splitInclusiveCache, tokenEventsFromBreakdown } from "./session-token-collectors.mjs";

export function finalizeClaudeDuplicateCandidates(candidates, seen) {
  const ambiguous = new Set([...seen].filter(([, entry]) => entry.ambiguous).map(([messageId]) =>
    createHash("sha256").update(messageId).digest("hex")));
  return candidates.filter((candidate) => !ambiguous.has(candidate.messageProofHash));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function historicalEvents(row, line, sessionKey) {
  const model = (typeof row.message.model === "string" && row.message.model.trim()) || "claude-3-7-sonnet";
  const stamp = typeof row.timestamp === "number" && row.timestamp <= 1e12 ? row.timestamp * 1000 : row.timestamp;
  const occurredAt = new Date(stamp);
  if (!Number.isFinite(occurredAt.getTime())) return [];
  const usage = row.message.usage;
  return tokenEventsFromBreakdown({ producerId: CLAUDE_PRODUCER_ID,
    provider: "anthropic", service: "claude-code", sessionKey,
    occurredAtIso: occurredAt.toISOString(), model,
    breakdown: splitInclusiveCache({ input: usage.input_tokens, output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens, cacheCreation: usage.cache_creation_input_tokens }),
    extraId: `L${line}:${model}`,
  });
}

/** Only identical message IDs, model, and full usage form deletion candidates. */
export function createClaudeDuplicateLinePlanner({ sessionKey, sourceProofHash, seen = new Map() } = {}) {
  if (!sessionKey) throw new Error("Exact collector sessionKey required");
  const candidates = [];
  const ambiguousHashes = new Set();
  const source = { hash: sourceProofHash };
  let ambiguousMessages = 0;
  function addLine(text, line) {
    let row;
    try { row = JSON.parse(text); } catch { return; }
    const message = row?.message;
    if (typeof message?.id !== "string" || !message.id || !message.usage || typeof message.usage !== "object") return;
    const signature = JSON.stringify(stable({ model: message.model, usage: message.usage }));
    const first = seen.get(message.id);
    if (!first) {
      seen.set(message.id, { signature, source, events: historicalEvents(row, line, sessionKey) });
      return;
    }
    if (first.signature !== signature || first.events.length === 0 || first.ambiguous) {
      ambiguousMessages++;
      first.ambiguous = true;
      ambiguousHashes.add(createHash("sha256").update(message.id).digest("hex"));
      return;
    }
    const events = historicalEvents(row, line, sessionKey);
    for (const event of events) {
      const keeper = first.events.find((keep) => keep.label === event.label && keep.quantity === event.quantity);
      if (!keeper || keeper.eventId === event.eventId) continue;
      candidates.push({ keeperSource: first.source, proof: { eventId: event.eventId, keeperEventId: keeper.eventId,
        quantity: event.quantity, label: event.label, occurredAt: event.occurredAt,
        keeperOccurredAt: keeper.occurredAt, model: event.metadata.model,
        usageProofHash: createHash("sha256").update(signature).digest("hex"),
        messageProofHash: createHash("sha256").update(message.id).digest("hex") } });
    }
  }
  function finish(hash = sourceProofHash) {
    source.hash = hash;
    return { candidates: candidates.filter(({ proof }) => !ambiguousHashes.has(proof.messageProofHash)).map(({ proof, keeperSource }) =>
      ({ ...proof, keeperSourceProofHash: keeperSource.hash })), ambiguousMessages };
  }
  return { addLine, finish };
}

export function planClaudeDuplicateLines(text, options) {
  const planner = createClaudeDuplicateLinePlanner(options);
  text.split("\n").forEach((line, index) => planner.addLine(line, index));
  return planner.finish();
}
