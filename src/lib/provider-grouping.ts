import { decrypt } from "@/lib/crypto";

export interface ExistingProviderCredential {
  id: string;
  name: string;
  groupId: string | null;
  apiKey: string | null;
}

export interface CredentialGroupPlan {
  groupId: string;
  providerIdsToBackfill: string[];
}

/**
 * Implicit balance grouping is safe only when provider name AND primary
 * credential match. Provider name alone does not identify an account: the app
 * intentionally supports multiple OpenAI/Resend/etc. accounts and keys.
 */
export function planCredentialGroup(
  providerName: string,
  plaintextApiKey: string | undefined,
  candidates: ExistingProviderCredential[]
): CredentialGroupPlan | null {
  if (!plaintextApiKey) return null;
  const nameKey = providerName.trim().toLowerCase();
  const matches = candidates.filter((candidate) => {
    if (candidate.name.trim().toLowerCase() !== nameKey || !candidate.apiKey) {
      return false;
    }
    try {
      return decrypt(candidate.apiKey) === plaintextApiKey;
    } catch {
      return false;
    }
  });
  if (matches.length === 0) return null;

  const existingGroup = matches.find((candidate) => candidate.groupId)?.groupId;
  const groupId = existingGroup ?? `credential:${matches[0].id}`;
  return {
    groupId,
    providerIdsToBackfill: matches
      .filter((candidate) => candidate.groupId == null)
      .map((candidate) => candidate.id),
  };
}
