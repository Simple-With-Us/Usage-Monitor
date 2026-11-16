/** Verify the complete legacy token metadata contract, never a 200 path probe.
 * @param {Record<string, unknown>} metadata
 * @param {{projectId: string, paths: string[], permissions: string[]}} expected
 */
export function assertServiceTokenMetadata(metadata, expected) {
  const same = (actual, wanted) => Array.isArray(actual) && actual.every((value) => typeof value === "string") && actual.length === new Set(actual).size && JSON.stringify([...actual].sort()) === JSON.stringify([...wanted].sort());
  if (metadata.workspace !== expected.projectId || !same(metadata.permissions, expected.permissions) || !Array.isArray(metadata.scopes)) throw new Error("token_scope_mismatch");
  const paths = [];
  for (const scope of metadata.scopes) {
    if (!scope || typeof scope !== "object" || scope.environment !== "prod" || typeof scope.secretPath !== "string") throw new Error("token_scope_mismatch");
    paths.push(scope.secretPath);
  }
  if (!same(paths, expected.paths)) throw new Error("token_scope_mismatch");
  if (metadata.expiresAt != null && (typeof metadata.expiresAt !== "string" || !Number.isFinite(Date.parse(metadata.expiresAt)) || Date.parse(metadata.expiresAt) <= Date.now())) throw new Error("token_expired");
}

/** Metadata only; bounded, allowlisted HTTPS, no redirect or response logging.
 * @param {{token: string, projectId: string, paths: string[], permissions: string[], baseUrl?: string, fetchImpl?: typeof fetch}} options
 */
export async function verifyServiceToken(options) {
  try {
    const url = new URL(options.baseUrl || "https://app.infisical.com");
    if (url.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error();
    const response = await (options.fetchImpl || fetch)(`${url.origin}/api/v2/service-token`, { headers: { authorization: `Bearer ${options.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.length;
        if (bytes > 128 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    assertServiceTokenMetadata(JSON.parse(Buffer.concat(chunks).toString("utf8")), options);
  } catch { throw new Error("service_token_verification_failed"); }
}
