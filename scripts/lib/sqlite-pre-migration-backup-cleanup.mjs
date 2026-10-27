import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isStalePartialMtime } from "./sqlite-pre-migration-backup-timing.mjs";

export function removeStalePartials(backupDirectory, prefix, log = () => {}, env = process.env) {
  const nowMs = Date.now();
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".partial")
    ) {
      continue;
    }
    const path = join(backupDirectory, entry.name);
    const { mtimeMs } = statSync(path);
    if (!isStalePartialMtime(mtimeMs, nowMs, env)) {
      continue;
    }
    unlinkSync(path);
    log(`removed stale partial ${entry.name}`);
  }
}
