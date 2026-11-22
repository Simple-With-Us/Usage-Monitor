#!/usr/bin/env node
/**
 * Offline gate: audit-ci.jsonc must be valid, must run at high severity and
 * must hold no malformed allowlist id, and audit-ci must pass at high
 * severity.  Mirrors .github/workflows/ci.yml audit step.  The allowlist is
 * empty on purpose: every id it held was a withdrawn advisory, and a retained
 * withdrawn id would suppress a real republished advisory.  Parses JSONC so a
 * comment mention of a withdrawn GHSA cannot satisfy a check.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";

const configPath = "audit-ci.jsonc";
const ghsaIdPattern = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

/**
 * Strip JSONC comments while leaving comment-like text inside strings alone.
 * Handles full-line comments, trailing comments and block comments.
 */
const stripJsonc = (text) => {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
};

const AuditCiSchema = z.object({
  high: z.boolean(),
  allowlist: z.array(z.string()),
});

const raw = readFileSync(configPath, "utf8");
let parsed;
try {
  parsed = JSON.parse(stripJsonc(raw));
} catch (err) {
  console.error(`${configPath} contains invalid JSONC: ${err.message}`);
  process.exit(1);
}

const snapshot = AuditCiSchema.safeParse(parsed);
if (!snapshot.success) {
  const issues = snapshot.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  console.error(`${configPath} does not match the expected audit-ci shape: ${issues}`);
  process.exit(1);
}

const malformedIds = snapshot.data.allowlist.filter((entry) => !ghsaIdPattern.test(entry));
if (malformedIds.length > 0) {
  console.error(`${configPath} allowlist holds entries that are not GHSA ids: ${malformedIds.join(", ")}`);
  process.exit(1);
}
if (snapshot.data.high !== true) {
  console.error(`${configPath} must set "high": true`);
  process.exit(1);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["audit-ci", "--config", configPath],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status === null ? 1 : result.status);
