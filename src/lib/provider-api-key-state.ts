import { decrypt } from "@/lib/crypto";

export interface ProviderApiKeyState {
  apiKeyConfigured: boolean;
  apiKeyReadable: boolean;
  keyPreview: string | null;
}

/**
 * Describe an encrypted provider key without returning the credential itself.
 * Keys shorter than four characters remain configured/readable but receive no
 * preview, so callers never expose the complete secret by treating it as a
 * "last four" value.
 */
export function providerApiKeyState(encryptedKey: string | null): ProviderApiKeyState {
  if (!encryptedKey) {
    return {
      apiKeyConfigured: false,
      apiKeyReadable: true,
      keyPreview: null,
    };
  }

  try {
    const decrypted = decrypt(encryptedKey);
    return {
      apiKeyConfigured: true,
      apiKeyReadable: true,
      keyPreview: decrypted.length >= 4 ? `••••${decrypted.slice(-4)}` : null,
    };
  } catch {
    return {
      apiKeyConfigured: true,
      apiKeyReadable: false,
      keyPreview: null,
    };
  }
}
