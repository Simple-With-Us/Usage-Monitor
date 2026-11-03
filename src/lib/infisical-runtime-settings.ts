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
  const stored = process.env.DATABASE_URL ? await loadInfisicalConnection("um") : null;
  if (isInfisicalConnectionDisabled("um")) { service.disableInfisicalConnection(); return; }
  const connection = stored ?? (process.env.INFISICAL_UM_READ_TOKEN ? infisicalConnectionFromEnv("um") : null);
  if (connection) await configureInfisicalRuntimeSettings(service, connection, async () => {});
  else await service.init();
}
