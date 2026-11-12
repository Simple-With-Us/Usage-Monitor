/** Canonical explicit Usage Monitor bootstrap coordinates.  No fleet fallback.
 * @param {Record<string, string | undefined>} env
 */
export function resolveUmInfisicalEnv(env) {
  const clean = (name) => env[name]?.trim() || undefined;
  const ownPair = Boolean(clean("INFISICAL_UM_CLIENT_ID") || clean("INFISICAL_UM_CLIENT_SECRET"));
  const token = clean("INFISICAL_UM_READ_TOKEN") || clean("INFISICAL_TOKEN");
  return {
    projectId: clean("INFISICAL_UM_PROJECT_ID") || clean("INFISICAL_PROJECT_ID") || clean("INFISICAL_APP_PROJECT_ID"),
    secretPath: clean("INFISICAL_UM_SECRET_PATH") || clean("INFISICAL_PATH") || "/",
    clientId: ownPair ? clean("INFISICAL_UM_CLIENT_ID") : clean("INFISICAL_CLIENT_ID"),
    clientSecret: ownPair ? clean("INFISICAL_UM_CLIENT_SECRET") : clean("INFISICAL_CLIENT_SECRET"),
    token,
    serviceToken: token?.startsWith("st.") ? token : undefined,
  };
}
