import { createSign } from "node:crypto";
import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
} from "./helpers";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_BIGQUERY_READONLY_SCOPE =
  "https://www.googleapis.com/auth/bigquery.readonly";
export const GOOGLE_MONITORING_READ_SCOPE =
  "https://www.googleapis.com/auth/monitoring.read";

export type GoogleReadOnlyOAuthScope =
  | typeof GOOGLE_BIGQUERY_READONLY_SCOPE
  | typeof GOOGLE_MONITORING_READ_SCOPE;

export interface GoogleServiceAccountCredential {
  type: "service_account";
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
  token_uri: typeof GOOGLE_TOKEN_ENDPOINT;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseGoogleServiceAccountCredential(
  value: unknown
): GoogleServiceAccountCredential {
  if (typeof value !== "string" || !value.trim()) {
    configurationError(
      "Google Cloud integration requires an encrypted serviceAccountJson credential"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    configurationError("Google Cloud serviceAccountJson is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    configurationError("Google Cloud serviceAccountJson must be a JSON object");
  }
  const credential = parsed as Record<string, unknown>;
  const projectId = cleanString(credential.project_id);
  const clientEmail = cleanString(credential.client_email);
  const privateKey = cleanString(credential.private_key);
  const tokenUri = cleanString(credential.token_uri);
  const privateKeyId = cleanString(credential.private_key_id);

  if (
    credential.type !== "service_account" ||
    !projectId ||
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) ||
    !clientEmail ||
    !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(clientEmail) ||
    !privateKey ||
    !privateKey.startsWith("-----BEGIN PRIVATE KEY-----") ||
    !privateKey.endsWith("-----END PRIVATE KEY-----") ||
    tokenUri !== GOOGLE_TOKEN_ENDPOINT
  ) {
    configurationError(
      "Google Cloud serviceAccountJson is not a supported service-account credential"
    );
  }

  return {
    type: "service_account",
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: GOOGLE_TOKEN_ENDPOINT,
    ...(privateKeyId ? { private_key_id: privateKeyId } : {}),
  };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function createAssertion(
  credential: GoogleServiceAccountCredential,
  scope: GoogleReadOnlyOAuthScope
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(credential.private_key_id ? { kid: credential.private_key_id } : {}),
  };
  const claims = {
    iss: credential.client_email,
    scope,
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims)
  )}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${base64Url(signer.sign(credential.private_key))}`;
  } catch {
    configurationError(
      "Google Cloud serviceAccountJson contains an unusable private key"
    );
  }
}

export async function fetchGoogleServiceAccountAccessToken(
  credential: GoogleServiceAccountCredential,
  scope: GoogleReadOnlyOAuthScope
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: createAssertion(credential, scope),
  });
  const response = await fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    errorResult(response.status, {
      note: "Google service-account token exchange failed",
    });
  }
  const token = cleanString(
    (response.data as { access_token?: unknown } | null)?.access_token
  );
  if (!token) {
    throw new AdapterError("Google token response omitted access_token", {
      code: "INVALID_RESPONSE",
    });
  }
  return token;
}
