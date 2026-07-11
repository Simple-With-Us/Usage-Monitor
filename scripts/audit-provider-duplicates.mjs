#!/usr/bin/env node
/** Read-only duplicate-provider audit. Never reads or prints credentials. */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
try {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
  const groups = new Map();
  for (const provider of providers) {
    const key = provider.name.trim().toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(provider.id);
    groups.set(key, group);
  }

  const duplicates = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicates.length === 0) {
    console.log("No duplicate provider names found.");
  } else {
    for (const [name, ids] of duplicates) {
      console.log(`${name}: ${ids.join(", ")}`);
    }
    console.log(
      `${duplicates.length} duplicate name group(s) found. Read-only audit; choose a primary and backup before any merge/delete.`
    );
  }
} finally {
  await prisma.$disconnect();
}
