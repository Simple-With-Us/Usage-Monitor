// External telemetry intentionally keeps the producer's provider string as
// received (it is part of the shared idempotency contract and useful for
// diagnostics). Read-time joins use this conservative alias table so legacy
// producer names still land on the correct configured Provider row.

function identityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function identitySlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  return slug.slice(start, end);
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  alphavantage: "alphavantage",
  anthropic: "anthropic",
  claude: "anthropic",
  claudeai: "anthropic",
  deepseek: "deepseek",
  financialmodelingprep: "fmp",
  financialmodelingpreparation: "fmp",
  fintechstudios: "fintech-studios",
  fmp: "fmp",
  gemini: "google-ai",
  geminiapi: "google-ai",
  generativelanguage: "google-ai",
  google: "google-ai",
  googleai: "google-ai",
  googleaistudio: "google-ai",
  googlegemini: "google-ai",
  grok: "xai",
  hetznercloud: "hetzner",
  backblaze: "backblaze",
  backblazeb2: "backblaze",
  b2: "backblaze",
  b2cloud: "backblaze",
  botfleet: "botfleet",
  botfleetapp: "botfleet",
  llamacloud: "llamaindex",
  llamaindex: "llamaindex",
  llamaindexcloud: "llamaindex",
  llamaparse: "llamaindex",
  massive: "massive",
  massivecom: "massive",
  polygon: "massive",
  polygonio: "massive",
  openrouter: "openrouter",
  openrouterai: "openrouter",
  pinecone: "pinecone",
  pineconedb: "pinecone",
  quiver: "quiver-quant",
  quiverquant: "quiver-quant",
  quiverquantitative: "quiver-quant",
  roic: "roic",
  roicai: "roic",
  rendercom: "render",
  twelvedata: "twelvedata",
  unusualwhales: "unusual-whales",
  uw: "unusual-whales",
  voyage: "voyage",
  voyageai: "voyage",
  xai: "xai",
};

/** Case-insensitive exact-name key. Exact configured names outrank aliases. */
export function normalizedProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Stable comparison key for provider joins. Never persist this over raw input. */
export function canonicalProviderKey(provider: string): string {
  const token = identityToken(provider);
  return PROVIDER_ALIASES[token] ?? identitySlug(provider);
}

export interface ProviderIdentityCandidate {
  id: string;
  name: string;
  identityPriority?: number;
}

interface CandidateIdentityKeys {
  normalized: string;
  canonical: string;
}

// E3: resolveProviderIdentity is called once per producer row over the same
// candidates array (budget-status's per-event identity resolution loops), and
// each call used to recompute normalizedProviderName/canonicalProviderKey for
// every candidate — two filter().sort() passes of O(candidates) regex work
// per row. The candidate keys depend only on the array contents, so compute
// them once per distinct candidates array and reuse them across calls.
// Callers already treat provider lists as read-only; the WeakMap key is the
// array identity, so a mutated-in-place array would be stale — matching how
// every call site (fetched fresh per compute) already behaves.
const candidateIdentityKeysCache = new WeakMap<
  readonly ProviderIdentityCandidate[],
  CandidateIdentityKeys[]
>();

function identityKeysForCandidates<T extends ProviderIdentityCandidate>(
  candidates: readonly T[]
): CandidateIdentityKeys[] {
  const cached = candidateIdentityKeysCache.get(candidates);
  if (cached) return cached;
  const computed = candidates.map((candidate) => ({
    normalized: normalizedProviderName(candidate.name),
    canonical: canonicalProviderKey(candidate.name),
  }));
  candidateIdentityKeysCache.set(candidates, computed);
  return computed;
}

/**
 * Resolve a producer provider label to one configured row. An exact configured
 * name wins (so a deliberate custom `gemini` connection is not stolen by the
 * built-in Google alias); alias fallback then prefers the canonical slug and a
 * stable id tie-break.
 */
export function resolveProviderIdentity<T extends ProviderIdentityCandidate>(
  provider: string,
  candidates: readonly T[]
): T | null {
  const keys = identityKeysForCandidates(candidates);

  const exactName = normalizedProviderName(provider);
  const exact = candidates
    .filter((candidate, index) => keys[index].normalized === exactName)
    .sort(
      (left, right) =>
        (right.identityPriority ?? 0) - (left.identityPriority ?? 0) ||
        left.id.localeCompare(right.id)
    );
  if (exact.length > 0) return exact[0];

  const canonical = canonicalProviderKey(provider);
  // Decorate-filter-sort: keeps the cached key lookup O(1) per candidate
  // instead of re-deriving it inside the comparator.
  const aliases = candidates
    .map((candidate, index) => ({ candidate, key: keys[index] }))
    .filter((entry) => entry.key.canonical === canonical)
    .sort((left, right) => {
      const leftCanonical = left.key.normalized === canonical ? 0 : 1;
      const rightCanonical = right.key.normalized === canonical ? 0 : 1;
      return leftCanonical - rightCanonical ||
        (right.candidate.identityPriority ?? 0) - (left.candidate.identityPriority ?? 0) ||
        left.candidate.id.localeCompare(right.candidate.id);
    });
  return aliases[0]?.candidate ?? null;
}

const PROJECT_ALIASES: Readonly<Record<string, string>> = {
  congresstrade: "congress-trade",
  congresstradecom: "congress-trade",
  socratictrade: "socratic-trade",
  socratictradecom: "socratic-trade",
  usagemonitor: "usage-monitor",
  apiusagemonitor: "usage-monitor",
  usagemonitorapp: "usage-monitor",
  dealdex: "dealdex",
  personalsite: "personal-site",
  topspin: "autorotate",
  autorotate: "autorotate",
  contactlogo: "contact-logo",
  contactlogocom: "contact-logo",
  aifleetcoordinator: "fleet",
  fleetinfra: "fleet",
  fleet: "fleet",
  fleetops: "fleet-ops",
  botfleet: "botfleet",
  botfleetapp: "botfleet",
};

/**
 * Comparison key for the legacy sourceApp -> Project.name fallback. Explicit
 * projectId attribution remains authoritative; this only recovers known old
 * names such as `socratic-trade` vs `SocraticTrade.com`.
 */
export function canonicalProjectKey(project: string): string {
  const token = identityToken(project);
  return PROJECT_ALIASES[token] ?? identitySlug(project);
}
