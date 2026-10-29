import { prisma } from "@/lib/prisma";

/**
 * AgentTurn has no unique key, and an OTLP exporter retries a whole request
 * when it does not see the response (OpenRouter Broadcast, the agent hook
 * shim, any collector behind a flaky link).  Every retry inserted the same
 * turns again.  A turn that carries a generation id is now written once per
 * (platform, generationId): repeats inside the batch are folded, and a turn
 * already stored is skipped.  A turn with no generation id cannot be told
 * apart from a genuinely new one, so it is always written, as before.
 *
 * This is a read-then-write, not a constraint: two concurrent retries of the
 * same request can still both insert.  A unique index would close that, but
 * it needs the existing duplicates cleaned first, so it is left for a
 * migration of its own.
 */

/** How far either side of a batch's turns the stored-turn lookup reaches. */
export const AGENT_TURN_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface TurnKeyFields {
  platform: string;
  generationId?: string | null;
  occurredAt: Date;
}

function turnKey(turn: { platform: string; generationId?: string | null }): string | null {
  const generationId = turn.generationId?.trim();
  return generationId ? `${turn.platform}\u0000${generationId}` : null;
}

export async function newAgentTurns<T extends TurnKeyFields>(turns: T[]): Promise<T[]> {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const turn of turns) {
    const key = turnKey(turn);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    unique.push(turn);
  }
  if (seen.size === 0) return unique;

  const keyed = unique.filter((turn) => turnKey(turn));
  const times = keyed.map((turn) => turn.occurredAt.getTime());
  const stored = await prisma.agentTurn.findMany({
    where: {
      platform: { in: [...new Set(keyed.map((turn) => turn.platform))] },
      generationId: { in: [...new Set(keyed.map((turn) => turn.generationId!.trim()))] },
      occurredAt: {
        gte: new Date(Math.min(...times) - AGENT_TURN_DEDUPE_WINDOW_MS),
        lte: new Date(Math.max(...times) + AGENT_TURN_DEDUPE_WINDOW_MS),
      },
    },
    select: { platform: true, generationId: true },
  });
  const existing = new Set(stored.map((row) => turnKey(row)).filter((key): key is string => !!key));
  if (existing.size === 0) return unique;
  return unique.filter((turn) => {
    const key = turnKey(turn);
    return !key || !existing.has(key);
  });
}
