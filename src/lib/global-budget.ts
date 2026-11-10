import { prisma } from "@/lib/prisma";

export type GlobalBudgetSource = "override" | "suggested" | "none";

export interface GlobalBudgetSnapshot {
  /** Explicit owner override; null = use suggestion when present. */
  globalMonthlyBudgetUsd: number | null;
  /** Sum of project.monthlyBudgetUsd where > 0. */
  suggestedGlobalBudgetUsd: number | null;
  /** Override if set, else suggested, else null. */
  effectiveGlobalBudgetUsd: number | null;
  globalBudgetSource: GlobalBudgetSource;
  projectBudgetCount: number;
}

export function resolveGlobalBudget(input: {
  overrideUsd: number | null | undefined;
  projectBudgets: Array<number | null | undefined>;
}): GlobalBudgetSnapshot {
  let suggested = 0;
  let projectBudgetCount = 0;
  for (const value of input.projectBudgets) {
    if (value != null && Number.isFinite(value) && value > 0) {
      suggested += value;
      projectBudgetCount += 1;
    }
  }
  const suggestedGlobalBudgetUsd =
    projectBudgetCount > 0 ? Math.round(suggested * 100) / 100 : null;

  const override =
    input.overrideUsd != null &&
    Number.isFinite(input.overrideUsd) &&
    input.overrideUsd > 0
      ? Math.round(input.overrideUsd * 100) / 100
      : null;

  if (override != null) {
    return {
      globalMonthlyBudgetUsd: override,
      suggestedGlobalBudgetUsd,
      effectiveGlobalBudgetUsd: override,
      globalBudgetSource: "override",
      projectBudgetCount,
    };
  }
  if (suggestedGlobalBudgetUsd != null) {
    return {
      globalMonthlyBudgetUsd: null,
      suggestedGlobalBudgetUsd,
      effectiveGlobalBudgetUsd: suggestedGlobalBudgetUsd,
      globalBudgetSource: "suggested",
      projectBudgetCount,
    };
  }
  return {
    globalMonthlyBudgetUsd: null,
    suggestedGlobalBudgetUsd: null,
    effectiveGlobalBudgetUsd: null,
    globalBudgetSource: "none",
    projectBudgetCount: 0,
  };
}

export async function loadGlobalBudgetSnapshot(): Promise<GlobalBudgetSnapshot> {
  const [settings, projects] = await Promise.all([
    prisma.appBudgetSettings.findUnique({ where: { id: "default" } }).catch(() => null),
    prisma.project.findMany({
      select: { monthlyBudgetUsd: true },
    }),
  ]);

  return resolveGlobalBudget({
    overrideUsd: settings?.globalMonthlyBudgetUsd ?? null,
    projectBudgets: projects.map((p) => p.monthlyBudgetUsd),
  });
}

export async function upsertGlobalMonthlyBudget(
  globalMonthlyBudgetUsd: number | null
): Promise<GlobalBudgetSnapshot> {
  const value =
    globalMonthlyBudgetUsd == null ||
    !Number.isFinite(globalMonthlyBudgetUsd) ||
    globalMonthlyBudgetUsd <= 0
      ? null
      : Math.round(globalMonthlyBudgetUsd * 100) / 100;

  await prisma.appBudgetSettings.upsert({
    where: { id: "default" },
    create: { id: "default", globalMonthlyBudgetUsd: value },
    update: { globalMonthlyBudgetUsd: value },
  });

  return loadGlobalBudgetSnapshot();
}

export function parseGlobalBudgetBody(body: unknown): {
  ok: true;
  value: number | null;
} | { ok: false; error: string } {
  if (body == null || typeof body !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const raw = (body as { globalMonthlyBudgetUsd?: unknown }).globalMonthlyBudgetUsd;
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, value: null };
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, error: "globalMonthlyBudgetUsd must be a non-negative number or null" };
  }
  if (num === 0) return { ok: true, value: null };
  return { ok: true, value: num };
}
