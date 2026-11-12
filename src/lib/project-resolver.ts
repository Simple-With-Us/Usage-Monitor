import { prisma } from "@/lib/prisma";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";

const PROJECT_BACKFILL_SCAN_CHUNK = 1_000;
const PROJECT_BACKFILL_UPDATE_CHUNK = 500;

let projectBackfillResumeAfterId: string | undefined;

export function __resetProjectBackfillResumeForTests(): void {
  projectBackfillResumeAfterId = undefined;
}

export interface ProjectIdentityCandidate {
  id: string;
  name: string;
  createdAt: Date | string;
}

/** Oldest canonical project wins, with id as a total-order tie-break. */
export function buildCanonicalProjectIdMap(
  projects: readonly ProjectIdentityCandidate[]
): Map<string, string> {
  const ordered = [...projects].sort((left, right) => {
    const byCreatedAt =
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return byCreatedAt || left.id.localeCompare(right.id);
  });
  const byName = new Map<string, string>();
  for (const project of ordered) {
    const key = canonicalProjectKey(project.name);
    if (key && !byName.has(key)) byName.set(key, project.id);
  }
  return byName;
}

// Resolves producer-supplied project identifiers (a plain name/key sent via
// OTEL_RESOURCE_ATTRIBUTES `project` for Claude Code, or the top-level
// `project` field on the generic ingest contract) to a Project.id.
//
// Matching is case-insensitive on Project.name. The Project table is tiny
// (one row per tracked project), so we fetch the candidates and match in JS
// rather than issuing one case-insensitive query per distinct name — SQLite
// has no reliable case-insensitive `IN` without a collation change.
//
// Unknown names resolve to nothing (the event's projectId stays null and the
// raw name is preserved in metadata so a Project created later can be
// back-filled). This keeps ingest decoupled from project existence: producers
// can tag freely and the owner creates Projects (with budgets) when ready.
export async function resolveProjectIdsByName(
  names: Iterable<string>
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const name of names) {
    const key = canonicalProjectKey(name);
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return new Map();

  const projects = await prisma.project.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return new Map(
    [...buildCanonicalProjectIdMap(projects)].filter(([key]) => wanted.has(key))
  );
}

function projectNameFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const raw = record.project ?? record["project.name"];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

export interface ProjectBackfillResult {
  scanned: number;
  updated: number;
  truncated: boolean;
}

/**
 * Resumable keyset sweep that attributes raw ExternalUsageEvents (with null projectId)
 * to active Projects by matching metadata.project or metadata["project.name"].
 */
export async function backfillUnattributedProjectIds(options?: {
  batchSize?: number;
  maxBatches?: number;
  afterId?: string | null;
}): Promise<ProjectBackfillResult> {
  const batchSize = options?.batchSize ?? PROJECT_BACKFILL_SCAN_CHUNK;
  const maxBatches = options?.maxBatches ?? 10;
  let afterId = options?.afterId !== undefined ? (options.afterId ?? undefined) : projectBackfillResumeAfterId;

  if (!prisma.project) {
    return { scanned: 0, updated: 0, truncated: false };
  }

  const projects = await prisma.project.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (projects.length === 0) {
    return { scanned: 0, updated: 0, truncated: false };
  }
  const projectIdMap = buildCanonicalProjectIdMap(projects);

  let scanned = 0;
  let updated = 0;
  let truncated = false;
  let batchCount = 0;

  while (batchCount < maxBatches) {
    batchCount += 1;
    const candidates = await prisma.externalUsageEvent.findMany({
      where: {
        projectId: null,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, metadata: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });

    if (candidates.length === 0) {
      projectBackfillResumeAfterId = undefined;
      break;
    }

    scanned += candidates.length;
    const lastRow = candidates[candidates.length - 1];
    afterId = lastRow.id;
    projectBackfillResumeAfterId = afterId;

    const idsByProject = new Map<string, string[]>();
    for (const row of candidates) {
      const rawName = projectNameFromMetadata(row.metadata);
      if (!rawName) continue;
      const key = canonicalProjectKey(rawName);
      if (!key) continue;
      const targetId = projectIdMap.get(key);
      if (!targetId) continue;

      let list = idsByProject.get(targetId);
      if (!list) {
        list = [];
        idsByProject.set(targetId, list);
      }
      list.push(row.id);
    }

    for (const [targetProjectId, matchingIds] of idsByProject) {
      for (
        let i = 0;
        i < matchingIds.length;
        i += PROJECT_BACKFILL_UPDATE_CHUNK
      ) {
        const chunk = matchingIds.slice(i, i + PROJECT_BACKFILL_UPDATE_CHUNK);
        const result = await withInternalUsageWriteAdmission(() =>
          prisma.externalUsageEvent.updateMany({
            where: { id: { in: chunk }, projectId: null },
            data: { projectId: targetProjectId },
          })
        );
        updated += result.count;
      }
    }

    if (candidates.length < batchSize) {
      projectBackfillResumeAfterId = undefined;
      break;
    }

    if (batchCount === maxBatches) {
      truncated = true;
    }
  }

  return { scanned, updated, truncated };
}

/**
 * Wave G / E6: when a Project is created, attach its id to raw
 * ExternalUsageEvent rows that still have projectId null but carry a matching
 * metadata.project or metadata["project.name"] name.
 *
 * @returns number of raw rows updated
 */
export async function backfillProjectIdFromMetadataName(
  projectId: string,
  projectName: string
): Promise<number> {
  const nameKey = canonicalProjectKey(projectName);
  if (!nameKey || !projectId) return 0;

  const res = await backfillUnattributedProjectIds({
    batchSize: 1_000,
    maxBatches: 5,
    afterId: null,
  });
  return res.updated;
}
