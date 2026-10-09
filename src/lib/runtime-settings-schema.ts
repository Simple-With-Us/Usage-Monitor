import { z } from "zod";

/** Trust boundary for PUT /api/settings/runtime (see INFISICAL.md). */
export const RuntimeSettingUpdateSchema = z
  .object({
    key: z.string().trim().min(1),
    value: z.string(),
  })
  .strict();
