import "server-only";
import type { AppSettingsService } from "./app-settings";
import { loadInfisicalConnection, infisicalConnectionFromEnv, isInfisicalConnectionDisabled, type InfisicalConnection } from "./infisical-connections";
import { createRoutedInfisicalSettings } from "./infisical-settings-client";

/** Keep DB access and credential storage out of the browser-safe settings facade. */
export async function configureInfisicalRuntimeSettings(service: AppSettingsService, connection: InfisicalConnection, persist: () => Promise<unknown>, options: Parameters<typeof createRoutedInfisicalSettings>[1] = {}) {
  const candidate = createRoutedInfisicalSettings(connection, options);
  try { await candidate.init(); await persist(); }
  catch (error) { candidate.stop(); throw error; }
  service.installInfisicalClient(candidate);
}

export async function initializeInfisicalRuntimeSettings(service: AppSettingsService) {
  try {
    const stored = process.env.DATABASE_URL ? await loadInfisicalConnection("um") : null;
    if (isInfisicalConnectionDisabled("um")) { service.disableInfisicalConnection(); return; }
    const connection = stored ?? infisicalConnectionFromEnv("um");
    if (connection) await configureInfisicalRuntimeSettings(service, connection, async () => {});
    else {
      if (process.env.INFISICAL_TOKEN?.trim() || process.env.INFISICAL_UM_READ_TOKEN?.trim()) throw new Error("unverifiable_runtime_token");
      await service.init();
    }
  } catch {
    // Keep deploy-time values available during a manager outage without
    // silently accepting ephemeral writes or trying another identity.
    service.disableInfisicalConnection();
    console.warn("[app-settings] Infisical initialization failed; using deploy-time environment reads and rejecting settings writes until the connection is verified");
  }
}
