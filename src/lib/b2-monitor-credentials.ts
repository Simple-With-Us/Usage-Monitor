/**
 * Read-only Backblaze monitor key resolution (fleet backup status, B2 app usage).
 * Env precedence matches `fleet-backup-status.ts` and platform storage probes.
 */

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveBackblazeMonitorCredentials():
  | { keyId: string; applicationKey: string }
  | null {
  const keyId =
    readText(process.env.BACKBLAZE_APPLICATION_KEY_ID) ||
    readText(process.env.B2_MONITOR_KEY_ID) ||
    readText(process.env.BACKBLAZE_KEY_ID) ||
    readText(process.env.B2_KEY_ID);
  const applicationKey =
    readText(process.env.BACKBLAZE_APPLICATION_KEY) ||
    readText(process.env.B2_MONITOR_APPLICATION_KEY) ||
    readText(process.env.B2_APPLICATION_KEY);
  if (!keyId || !applicationKey) return null;
  return { keyId, applicationKey };
}
