import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const PLAN_CLAIM_PATH = ["https://api.openai.com/auth", "chatgpt_plan_type"];

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function claimAt(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim().toLowerCase() : null;
}

/**
 * Read ChatGPT plan type from a Codex auth.json object.  Never returns tokens.
 * Local CLI login already stores chatgpt_plan_type on the id_token.
 */
export function planTypeFromCodexAuth(auth) {
  if (!auth || typeof auth !== "object") return null;
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const idToken = tokens.id_token || tokens.idToken;
  const payload = decodeJwtPayload(idToken);
  return claimAt(payload, PLAN_CLAIM_PATH);
}

export async function readCodexObservedPlan(authPath) {
  try {
    const raw = await readFile(authPath, "utf8");
    const auth = JSON.parse(raw);
    const planType = planTypeFromCodexAuth(auth);
    if (!planType) return null;
    return { planType };
  } catch {
    return null;
  }
}

export function observedPlanEvent({ planType, occurredAtIso }) {
  const day = occurredAtIso.slice(0, 10);
  return {
    eventId: createHash("sha256")
      .update(["openai-codex", "observed-plan", planType, day].join("\0"))
      .digest("hex"),
    provider: "openai",
    service: "codex-cli",
    producerKeyRef: planType,
    label: "observed-plan",
    metricType: "quota_sync",
    quantity: 1,
    billingMode: "estimated",
    confidence: "estimated",
    occurredAt: `${day}T00:00:00.000Z`,
    metadata: { chatgptPlanType: planType },
  };
}
