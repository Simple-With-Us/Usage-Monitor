import { prisma } from "@/lib/prisma";

/**
 * Wave F / E17: keep Simple Tools Relay as a catalog/health-only row, never an
 * active poll target. Ops health lives in Sentry / OperationsOverview; polling
 * a health URL from the usage loop only creates missing_snapshot noise.
 */
export async function ensureSimpleToolsProviderSeeded(): Promise<void> {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true, isActive: true, refreshIntervalMin: true },
  });

  const relay = providers.find((p) => p.name.toLowerCase() === "simple-tools-relay");
  if (relay) {
    if (relay.isActive || relay.refreshIntervalMin < 1440) {
      await prisma.provider.update({
        where: { id: relay.id },
        data: {
          isActive: false,
          // Even if re-enabled manually, avoid sub-daily self-poll burn.
          refreshIntervalMin: Math.max(relay.refreshIntervalMin, 1440),
          alertConfigGeneration: { increment: 1 },
        },
      });
    }
  } else {
    await prisma.provider.create({
      data: {
        name: "simple-tools-relay",
        displayName: "Simple Tools Relay",
        type: "builtin",
        isActive: false,
        refreshIntervalMin: 1440,
      },
    });
  }
}
