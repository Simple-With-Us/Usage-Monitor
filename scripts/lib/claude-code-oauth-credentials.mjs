// Trust-boundary parser for Claude Code OAuth credential JSON injected via env
// or read from the legacy ~/.claude/.credentials.json file.  Never log raw JSON
// or token values.

import { z } from "zod";

const ClaudeAiOauthSchema = z
  .object({
    accessToken: z.string().optional(),
    access_token: z.string().optional(),
    expiresAt: z.union([z.number(), z.string()]).optional(),
    expires_at: z.union([z.number(), z.string()]).optional(),
    subscriptionType: z.string().optional(),
    subscription_type: z.string().optional(),
  })
  .strip();

const ClaudeCodeCredentialsSchema = z
  .object({
    claudeAiOauth: ClaudeAiOauthSchema.optional(),
  })
  .strip();

/**
 * Parse and validate Claude Code credential JSON from env or a file read.
 * Returns the stripped credential object, or null when JSON or schema is invalid.
 * Logs only a generic schema failure — never the payload or tokens.
 */
export function parseClaudeCodeCredentialsJson(raw, { logImpl } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (logImpl) {
      logImpl("claude: OAuth credential JSON is not valid JSON");
    }
    return null;
  }
  const result = ClaudeCodeCredentialsSchema.safeParse(parsed);
  if (!result.success) {
    if (logImpl) {
      logImpl("claude: OAuth credential JSON failed schema validation");
    }
    return null;
  }
  return result.data;
}
