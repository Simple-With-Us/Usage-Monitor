import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// The CLI evaluates this file even for commands that never open a connection
// (`prisma generate`, `prisma validate`), so the datasource is declared only
// when DATABASE_URL is set.  A container build runs `npm ci` -> `prisma
// generate` without that variable, and resolving it unconditionally failed the
// build with PrismaConfigEnvError.  When the variable is set the URL is passed
// through verbatim, and when it is not, commands that really need a URL (migrate,
// db push) still fail with Prisma's own missing-datasource error instead of
// writing to an invented fallback path.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  ...(databaseUrl ? { datasource: { url: env("DATABASE_URL") } } : {}),
  experimental: {
    externalTables: true,
  },
  tables: {
    // Litestream owns these tables. Prisma must never diff, recreate, or drop
    // them during startup schema synchronization.
    external: ["_litestream_seq", "_litestream_lock"],
  },
});
