#!/usr/bin/env node
import { resolveUmInfisicalEnv } from "./lib/infisical-app-auth-env.mjs";
import { verifyServiceToken } from "./lib/infisical-service-token.mjs";
const permission = process.argv[2];
const auth = resolveUmInfisicalEnv(process.env);
const token = process.env.INFISICAL_TOKEN?.trim() || (permission === "write" ? process.env.INFISICAL_UM_WRITE_TOKEN?.trim() : auth.token);
try {
  if (!["read", "write", "config"].includes(permission) || (permission !== "config" && !token) || !auth.projectId || (process.env.INFISICAL_ENV && process.env.INFISICAL_ENV !== "prod")) throw new Error();
  const url = new URL(process.env.INFISICAL_BASE_URL || process.env.INFISICAL_API_URL || "https://app.infisical.com");
  if (url.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["", "/", "/api"].includes(url.pathname)) throw new Error();
  if (!/^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/.test(auth.secretPath) || auth.secretPath.split("/").some((part) => part === "." || part === "..")) throw new Error();
  if (permission !== "config" && token.startsWith("st.")) await verifyServiceToken({ token, projectId: auth.projectId, paths: [auth.secretPath], permissions: [permission], baseUrl: url.origin });
} catch {
  console.error("Infisical token does not verify the exact project/prod/folder permission");
  process.exit(2);
}
