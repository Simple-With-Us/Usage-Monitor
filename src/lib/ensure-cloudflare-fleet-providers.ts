import { encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

/**
 * Four Cloudflare dashboard accounts, one Provider row each.
 *
 * Live UM had zero `cloudflare` rows, so the adapter never polled even though
 * Platforms/R2 already knew the four account ids. Boot creates or reactivates
 * these rows from env (Infisical-injected). Usage.Jays.Services uses its own
 * token (`CLOUDFLARE_JAY_*` / `R2_USAGE_*`) first — that is not the ST, CT,
 * or Old token. Fleet token is the fallback (Old has no dedicated token).
 *
 * Does not touch mustKeepFunded. Does not touch retired providers.
 */
export type CloudflareFleetSlotId = "um" | "st" | "ct" | "old";

export interface CloudflareFleetSlot {
  id: CloudflareFleetSlotId;
  name: string;
  displayName: string;
  accountEnv: string[];
  tokenEnv: string[];
}

export const CLOUDFLARE_FLEET_SLOTS: readonly CloudflareFleetSlot[] = [
  {
    id: "um",
    name: "cloudflare-usage-jays",
    displayName: "Cloudflare (Usage.Jays.Services)",
    accountEnv: [
      "R2_USAGE_ACCOUNT_ID",
      "CLOUDFLARE_JAY_ACCOUNT_ID",
      "CLOUDFLARE_ACCOUNT_ID",
    ],
    tokenEnv: [
      "CLOUDFLARE_JAY_API_TOKEN",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_FLEET_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
    ],
  },
  {
    id: "st",
    name: "cloudflare-socratic",
    displayName: "Cloudflare (Socratic.Trade)",
    accountEnv: ["CLOUDFLARE_ST_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_ST_API_TOKEN", "CLOUDFLARE_FLEET_API_TOKEN"],
  },
  {
    id: "ct",
    name: "cloudflare-congress",
    displayName: "Cloudflare (Congress.Trade)",
    accountEnv: ["CLOUDFLARE_CT_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_CT_API_TOKEN", "CLOUDFLARE_FLEET_API_TOKEN"],
  },
  {
    id: "old",
    name: "cloudflare-jay-old",
    displayName: "Cloudflare (Jay Old)",
    accountEnv: ["CLOUDFLARE_OLD_ACCOUNT_ID"],
    tokenEnv: ["CLOUDFLARE_OLD_API_TOKEN", "CLOUDFLARE_FLEET_API_TOKEN"],
  },
];

export function isCloudflareFleetProviderName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "cloudflare" || n.startsWith("cloudflare-");
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function resolveCloudflareFleetSlot(
  slot: CloudflareFleetSlot
): { accountId: string; apiToken: string } | null {
  const accountId = firstEnv(slot.accountEnv);
  const apiToken = firstEnv(slot.tokenEnv);
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

export async function ensureCloudflareFleetProvidersSeeded(): Promise<{
  created: number;
  updated: number;
  skipped: number;
}> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const existing = await prisma.provider.findMany({
    select: {
      id: true,
      name: true,
      displayName: true,
      isActive: true,
      config: true,
    },
  });

  for (const slot of CLOUDFLARE_FLEET_SLOTS) {
    const resolved = resolveCloudflareFleetSlot(slot);
    if (!resolved) {
      skipped += 1;
      continue;
    }

    let apiKey: string;
    try {
      apiKey = encrypt(resolved.apiToken);
    } catch {
      skipped += 1;
      continue;
    }

    const row = existing.find(
      (p) => p.name.toLowerCase() === slot.name.toLowerCase()
    );
    const publicConfig = {
      accountId: resolved.accountId,
      authMode: "api_token",
    };

    if (!row) {
      await prisma.provider.create({
        data: {
          name: slot.name,
          displayName: slot.displayName,
          type: "builtin",
          category: "Infrastructure",
          isActive: true,
          refreshIntervalMin: 60,
          apiKey,
          config: publicConfig,
        },
      });
      created += 1;
      continue;
    }

    // Existing row: refresh account id / token, but never force isActive.
    // Owner can turn the switch off; later ticks must leave that choice alone.
    const prev =
      row.config && typeof row.config === "object" && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {};
    const nextConfig = { ...prev, ...publicConfig };
    const configUnchanged =
      prev.accountId === publicConfig.accountId &&
      prev.authMode === publicConfig.authMode;
    const metaUnchanged =
      row.displayName === slot.displayName &&
      configUnchanged;
    if (metaUnchanged) {
      skipped += 1;
      continue;
    }
    await prisma.provider.update({
      where: { id: row.id },
      data: {
        displayName: slot.displayName,
        type: "builtin",
        category: "Infrastructure",
        apiKey,
        config: nextConfig,
      },
    });
    updated += 1;
  }

  if (created > 0 || updated > 0) {
    console.info(
      `[cloudflare-fleet-seed] created=${created} updated=${updated} skipped=${skipped}`
    );
  }

  return { created, updated, skipped };
}
