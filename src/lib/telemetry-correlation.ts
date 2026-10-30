/**
 * Correlation metadata: keys that say WHERE an event came from (which harness
 * session, which orchestrator launched it), not WHAT it measured.
 *
 * Producers learn these after they first ship an event: a collector starts
 * reading a session id it used to ignore, or starts recognising a session as
 * launched by BotFleet.  The next replay of an already-stored event then
 * carries a key the stored row lacks.  Comparing that as content would answer
 * the whole batch with 409 idempotency_conflict on every replay, and the
 * producer would go dark.  So a correlation key present on only ONE side of a
 * replay is ignored; present on both, it is compared as usual, so a changed
 * value still collides.
 */

/** The harness's own session id (Claude `sessionId`, opencode `ses_…`, Codex thread). */
export const SESSION_ID_METADATA_KEY = "session.id";

/** The producer's authoritative call/message identity, when available. */
export const CALL_ID_METADATA_KEY = "call.id";

/** Which orchestrator launched the session, when a collector can tell ("botfleet"). */
export const LAUNCHER_METADATA_KEY = "agent.launcher";

/** The orchestrator's own thread or session id, when the child knows it. */
export const LAUNCHER_SESSION_METADATA_KEY = "agent.launcher.session";

export const CORRELATION_METADATA_KEYS: readonly string[] = [
  SESSION_ID_METADATA_KEY,
  CALL_ID_METADATA_KEY,
  LAUNCHER_METADATA_KEY,
  LAUNCHER_SESSION_METADATA_KEY,
];

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The correlation keys present on exactly one side of a replay comparison. */
export function oneSidedCorrelationKeys(left: unknown, right: unknown): string[] {
  const l = metadataRecord(left);
  const r = metadataRecord(right);
  return CORRELATION_METADATA_KEYS.filter((key) => {
    const inLeft = !!l && key in l;
    const inRight = !!r && key in r;
    return inLeft !== inRight;
  });
}

/** Metadata without the given keys; null when nothing else is left. */
export function withoutMetadataKeys(value: unknown, keys: readonly string[]): unknown {
  const record = metadataRecord(value);
  if (!record || keys.length === 0 || !keys.some((key) => key in record)) return value;
  const rest = { ...record };
  for (const key of keys) delete rest[key];
  return Object.keys(rest).length > 0 ? rest : null;
}

export function readMetadataString(metadata: unknown, key: string): string | undefined {
  const record = metadataRecord(metadata);
  const value = record?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
