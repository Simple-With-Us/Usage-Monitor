import { z } from "zod";

/** Trust boundary for PUT /api/settings (dashboard session). */
export const SettingsUpdateSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    minSeverity: z.enum(["info", "warning", "critical"]).optional(),
    pushoverUserKey: z.string().optional(),
    pushoverApiToken: z.string().optional(),
  })
  .strict();
