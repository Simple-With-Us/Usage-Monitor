import { prisma } from "@/lib/prisma";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { bustBudgetStatusCache } from "@/lib/budget-status";

/**
 * One Usage Monitor Project row per fleet product. Idempotent: an existing
 * row whose canonical name matches (including aliases such as
 * SocraticTrade.com ↔ Socratic.Trade) is left in place. Never invents
 * Provider connections — projects are attribution buckets only.
 */
export interface FleetProjectSeed {
  name: string;
  description: string;
}

export const FLEET_PROJECT_SEEDS: readonly FleetProjectSeed[] = [
  {
    name: "Socratic.Trade",
    description: "Socratic.Trade product spend (web, iOS, and producer telemetry).",
  },
  {
    name: "Congress.Trade",
    description: "Congress.Trade product spend (web, iOS, and producer telemetry).",
  },
  {
    name: "Usage Monitor",
    description: "Usage Monitor itself (hosting, observability, and this app's own APIs).",
  },
  {
    name: "DealDex",
    description: "DealDex product spend (web, iOS, and Vercel hosting).",
  },
  {
    name: "Personal-Site",
    description: "Personal-Site (jays.services) product spend.",
  },
  {
    name: "Autorotate",
    description: "Autorotate (formerly TopSpin) native apps and related spend.",
  },
  {
    name: "ContactLogo",
    description: "ContactLogo product spend.",
  },
  {
    name: "Fleet",
    description: "Shared fleet infra (ai-fleet-coordinator, Mac jobs, board, Slack).",
  },
];

export interface EnsureFleetProjectsResult {
  created: number;
  existing: number;
  names: string[];
}

export async function ensureFleetProjectsSeeded(): Promise<EnsureFleetProjectsResult> {
  if (typeof prisma.project?.findMany !== "function") {
    return { created: 0, existing: 0, names: [] };
  }
  const existing = await prisma.project.findMany({
    select: { id: true, name: true, nameKey: true, description: true },
  });
  const byKey = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    const key = row.nameKey || canonicalProjectKey(row.name);
    if (!byKey.has(key)) byKey.set(key, row);
  }

  let created = 0;
  let unchanged = 0;
  const names: string[] = [];

  for (const seed of FLEET_PROJECT_SEEDS) {
    const key = canonicalProjectKey(seed.name);
    const row = byKey.get(key);
    if (row) {
      unchanged += 1;
      names.push(row.name);
      if (!row.nameKey) {
        await prisma.project.update({
          where: { id: row.id },
          data: { nameKey: key },
        });
      }
      continue;
    }

    const project = await prisma.project.create({
      data: {
        name: seed.name,
        nameKey: key,
        description: seed.description,
      },
    });
    byKey.set(key, {
      id: project.id,
      name: project.name,
      nameKey: project.nameKey,
      description: project.description,
    });
    created += 1;
    names.push(project.name);
  }

  if (created > 0) bustBudgetStatusCache();

  return { created, existing: unchanged, names };
}
