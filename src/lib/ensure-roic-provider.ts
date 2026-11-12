import { prisma } from "@/lib/prisma";

/**
 * Ensure a visible ROIC.ai catalog row exists so Overview/Settings can show it.
 * Blind / push-manual only — no poll; track cost via Subscription or ingest.
 *
 * Name match is JS case-insensitive (SQLite has no Prisma `mode: "insensitive"`).
 * Uses findMany like ensure-simple-tools-provider so partial prisma test doubles
 * that only stub findMany/create still exercise this path safely.
 */
export async function ensureRoicProviderSeeded(): Promise<void> {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const existing = providers.find((p) => {
    const n = p.name.toLowerCase();
    return n === "roic" || n === "roic.ai";
  });
  if (existing) return;

  await prisma.provider.create({
    data: {
      name: "roic",
      displayName: "ROIC.ai",
      type: "builtin",
      category: "Market Data",
      isActive: true,
      // No poll API — daily is enough if someone re-enables probing later.
      refreshIntervalMin: 1440,
    },
  });
}
