import { prisma } from "@/lib/prisma";
import {
  isDecommissionedBuiltInProvider,
} from "@/lib/provider-definitions";

/**
 * Idempotently disable legacy built-ins without deleting any financial or
 * usage evidence. This runs at Node startup before the scheduler is allowed
 * to start; the polling boundary also filters these rows fail-closed.
 */
export async function deactivateDecommissionedBuiltInProviders(): Promise<number> {
  const activeBuiltIns = await prisma.provider.findMany({
    where: { type: "builtin", isActive: true },
    select: { id: true, name: true, type: true },
  });
  const ids = activeBuiltIns
    .filter(isDecommissionedBuiltInProvider)
    .map((provider) => provider.id);
  if (ids.length === 0) return 0;

  const result = await prisma.provider.updateMany({
    where: { id: { in: ids }, isActive: true },
    data: {
      isActive: false,
      alertConfigGeneration: { increment: 1 },
    },
  });
  return result.count;
}
