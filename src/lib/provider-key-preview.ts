/**
 * Builds a client-safe preview of a decrypted API key: the first six and
 * last four characters, e.g. `sk-ant...wxyz`. Returns null for missing or
 * short keys (length <= 10) rather than risk an unsafe partial reveal.
 *
 * This is the single source of truth for key-preview formatting — every
 * server endpoint and UI surface that mentions a key must render this
 * exact string (or the null-preview fallback), never a hand-rolled slice.
 */
export function buildKeyPreview(decryptedKey: string | null): string | null {
  if (!decryptedKey || decryptedKey.length <= 10) return null;
  return `${decryptedKey.slice(0, 6)}...${decryptedKey.slice(-4)}`;
}
