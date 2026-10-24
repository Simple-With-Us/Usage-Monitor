import { createPrismaClient } from "../src/lib/create-prisma-client";

const prisma = createPrismaClient();

async function main() {
  const providers = await prisma.provider.findMany({
    include: { allocations: true },
  });

  console.log("Total providers:", providers.length);
  for (const p of providers) {
    if (p.allocations.length === 0) {
      console.log(`Unallocated Provider: ${p.displayName || p.name} (ID: ${p.id})`);
    } else {
      console.log(`Allocated Provider: ${p.displayName || p.name} (Allocations: ${p.allocations.map(a => a.percentage + '%').join(', ')})`);
    }
  }
}

main().finally(() => prisma.$disconnect());
