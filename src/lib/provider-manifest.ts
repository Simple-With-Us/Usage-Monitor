// =============================================================================
// provider-manifest — backend-driven provider display registry
// =============================================================================
//
// Renders of /api/quota-windows' `providerGroups[]` are read by CodeCaps (Mac,
// iOS, widget).  This module owns the manifest the apps pull from: a list of
// providers with display label, icon hint, sort order, alias map, and quota
// terms.  The manifest is stored as one JSON value in the Infisical
// `usage-monitor` project under the key
//
//   PROVIDER_MANIFEST_JSON
//
// and merged on top of the compiled-in defaults below (so the endpoint is
// usable offline / without credentials / on a fresh boot).
//
// Editing the manifest in Infisical takes effect on the next app sync
// (within the canonical 5-minute INFISICAL_SETTINGS_REFRESH_MS refresh — see
// src/lib/app-settings.ts); no deploy, no app release.  The design borrows
// from Paseo (plugins install via a `paseo-plugin.json` manifest without
// host-repo changes — docs at paseo.sh/docs/plugins/reference) and Cherry
// Studio (in-app custom providers, user-addable without a release) — what we
// want is the host-owned registry/manifest shape plus the "add a new provider
// = registry edit, never an app code change" UX cue.  Neither project's auth
// model is borrowed — CodeCaps needs no per-provider API keys.
//
// Precedence: manifest entries WIN over compiled-in defaults, per field.
// Fields a manifest entry does not set keep their default values (so an
// entry that only adds an alias cannot clobber the label).  The manifest
// can override a label, add aliases to an existing provider, add a
// brand-new provider not in the defaults, change sort order, change icon
// hint, and change quota-term defaults.  The defaults stay as the offline
// seed so a freshly booted process (or a unit test) always has a complete
// provider registry.
//
// Failure modes:
//   - Missing knob: serve compiled defaults, no log.
//   - Malformed JSON or bad shape: serve compiled defaults, log LOUDLY
//     (matching the existing settings-failure ethos in src/lib/app-settings.ts).
//
// Secret-safety: the manifest holds display/config only (no API keys, tokens,
// or passphrases by construction).  Provider-key strings + icon hints are not
// secrets; nothing here ever goes to logs at the secret-bearing level.

import { appSettings } from "@/lib/app-settings";

/**
 * Infisical key for the manifest JSON.  Stored as one secret under the
 * `usage-monitor` Infisical project; editable via PUT /api/settings/runtime
 * when typed as a string (raw JSON payload).
 */
export const PROVIDER_MANIFEST_KEY = "PROVIDER_MANIFEST_JSON";

/** Compiled-in defaults — the offline/seed registry. Mirrors the prior
 *  hardcoded maps in `src/lib/quota-windows.ts`. */
export const DEFAULT_PROVIDER_MANIFEST: ProviderManifest = {
  providers: [
    {
      key: "anthropic",
      label: "Claude",
      sortOrder: 10,
      iconHint: "anthropic",
      aliases: ["claude", "claude-code"],
      expected: true,
      terms: { defaultWindowLabel: "5h" },
    },
    {
      key: "openai",
      label: "Codex",
      sortOrder: 20,
      iconHint: "openai",
      aliases: ["codex", "openai-codex"],
      expected: true,
      terms: { defaultWindowLabel: "5h" },
    },
    {
      key: "google-antigravity",
      label: "Antigravity",
      sortOrder: 30,
      iconHint: "google-antigravity",
      aliases: ["google", "antigravity", "antigravity-cli"],
      expected: true,
      terms: { defaultWindowLabel: "5h", via: "antigravity" },
    },
    {
      key: "xai",
      label: "Grok",
      sortOrder: 40,
      iconHint: "xai",
      aliases: ["grok", "grok-build"],
      expected: true,
      terms: { defaultWindowLabel: "monthly" },
    },
    {
      key: "minimax",
      label: "MiniMax",
      sortOrder: 50,
      iconHint: "minimax",
      aliases: ["minimax-code"],
      expected: true,
      terms: { defaultWindowLabel: "5h" },
    },
    {
      key: "grok-bot",
      label: "Grok Bot",
      sortOrder: 60,
      iconHint: "grok-bot",
      aliases: ["gbu"],
      expected: true,
      terms: { defaultWindowLabel: "weekly" },
    },
    {
      key: "muse",
      label: "Muse",
      sortOrder: 70,
      iconHint: "muse",
      expected: true,
      terms: { defaultWindowLabel: "weekly" },
    },
  ],
};

// ---- Manifest schema --------------------------------------------------------

/**
 * Quota-window term defaults for a provider.  Add only what is NOT derivable
 * from a `windows[]` row (resetAt + window).  When a provider has no
 * windows reported yet (an "expected" provider), these defaults seed the UI.
 */
export interface ProviderTerms {
  /** Short human label for the default window (e.g. "5h", "weekly"). */
  defaultWindowLabel?: string;
  /** Through-route marker (currently only "antigravity"). */
  via?: string;
}

export interface ProviderManifestEntry {
  /** Canonical provider key (lowercase slug, no spaces). */
  key: string;
  /**
   * Human label shown in the apps (e.g. "Claude").  Optional on overrides:
   * when omitted, the compiled default's label is kept (so an entry that only
   * tweaks sortOrder can't clobber the label).  Required in effect for
   * brand-new providers, where it falls back to the key.
   */
  label?: string;
  /** Display order — lower first.  Optional; missing implies "after the sorted ones". */
  sortOrder?: number;
  /** Asset-name hint for the provider icon.  Apps fall back to a neutral mark. */
  iconHint?: string;
  /** Provider-key aliases that should normalize onto this canonical key. */
  aliases?: string[];
  /** When true, the provider gets an empty row in providerGroups even with no windows. */
  expected?: boolean;
  /** Quota-window display terms (only what's not derivable from windows[]). */
  terms?: ProviderTerms;
}

export interface ProviderManifest {
  /** Schema version.  Currently "1". */
  version?: string;
  providers: ProviderManifestEntry[];
}

// ---- Resolved registry (merged) --------------------------------------------

export interface ResolvedProviderConfig {
  /** Canonical provider key. */
  key: string;
  /** Human label. */
  label: string;
  /** Display order; lower first. Defaults to 1000 when unspecified. */
  sortOrder: number;
  /** Icon-asset hint; undefined means "no hint, app falls back". */
  iconHint?: string;
  /** Aliases that normalize onto this key (input-side, lowercase). */
  aliases: string[];
  /** When true, the provider gets an empty row even with no windows. */
  expected: boolean;
  /** Quota-window display terms. */
  terms: ProviderTerms;
}

export interface ResolvedProviderManifest {
  providers: ResolvedProviderConfig[];
  /** Lookup: raw provider slug → canonical key. */
  aliasToKey: Map<string, string>;
  /** Lookup: canonical key → resolved config. */
  byKey: Map<string, ResolvedProviderConfig>;
  /** True when this resolution came from a non-empty, well-formed Infisical knob. */
  fromInfisical: boolean;
}

// ---- Validation -------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function validateEntry(raw: unknown, idx: number): ProviderManifestEntry | null {
  if (!isPlainObject(raw)) {
    console.warn(
      `[provider-manifest] skipping entry[${idx}]: not an object`,
    );
    return null;
  }
  const key = asNonEmptyString(raw.key);
  if (!key) {
    console.warn(
      `[provider-manifest] skipping entry[${idx}]: missing key`,
    );
    return null;
  }
  const label = asNonEmptyString(raw.label) ?? undefined;
  const sortOrder =
    typeof raw.sortOrder === "number" && Number.isFinite(raw.sortOrder)
      ? raw.sortOrder
      : undefined;
  const iconHint = asNonEmptyString(raw.iconHint) ?? undefined;
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .map((a) => asNonEmptyString(a))
        .filter((a): a is string => a !== null)
    : [];
  const expected = raw.expected === true;
  const termsRaw = isPlainObject(raw.terms) ? raw.terms : {};
  const terms: ProviderTerms = {
    defaultWindowLabel: asNonEmptyString(termsRaw.defaultWindowLabel) ?? undefined,
    via: asNonEmptyString(termsRaw.via) ?? undefined,
  };
  return {
    key,
    label,
    sortOrder,
    iconHint,
    aliases,
    expected,
    terms,
  };
}

/**
 * Validate a raw parsed JSON value as a `ProviderManifest`.  Returns the
 * sanitized manifest, or `null` if the value was structurally invalid.  Logs
 * LOUDLY on bad shape (per the settings-failure ethos).
 */
export function parseProviderManifest(raw: unknown): ProviderManifest | null {
  if (!isPlainObject(raw)) {
    console.warn(
      "[provider-manifest] raw value is not an object; falling back to defaults",
    );
    return null;
  }
  if (!Array.isArray(raw.providers)) {
    console.warn(
      "[provider-manifest] raw.providers is not an array; falling back to defaults",
    );
    return null;
  }
  const entries: ProviderManifestEntry[] = [];
  raw.providers.forEach((item, idx) => {
    const parsed = validateEntry(item, idx);
    if (parsed) entries.push(parsed);
  });
  if (entries.length === 0) {
    console.warn(
      "[provider-manifest] no valid entries after validation; falling back to defaults",
    );
    return null;
  }
  return {
    version: asNonEmptyString(raw.version) ?? "1",
    providers: entries,
  };
}

// ---- Resolution (defaults → merged) -----------------------------------------

/**
 * Apply manifest entries on top of compiled defaults.  Manifest wins on key
 * collisions; brand-new keys are additive.  The returned registry is
 * deterministic: sorted by sortOrder then label.
 */
export function resolveProviderManifest(
  manifest: ProviderManifest | null,
): ResolvedProviderManifest {
  // Build the base map from defaults, deep-cloning each entry so manifest
  // merges cannot mutate the compiled-in seed.
  const byKey = new Map<string, ResolvedProviderConfig>();
  for (const def of DEFAULT_PROVIDER_MANIFEST.providers) {
    byKey.set(def.key, {
      key: def.key,
      label: def.label ?? def.key,
      sortOrder: def.sortOrder ?? 1000,
      iconHint: def.iconHint,
      aliases: [...(def.aliases ?? [])],
      expected: def.expected ?? true,
      terms: { ...def.terms },
    });
  }

  // Apply manifest overrides / additions on top.
  if (manifest) {
    for (const entry of manifest.providers) {
      const existing = byKey.get(entry.key);
      if (existing) {
        // Per-field merge: only fields the manifest explicitly sets win.
        // (A missing label keeps the default's label — it must not collapse
        // to the raw key.)
        if (entry.label !== undefined) existing.label = entry.label;
        if (entry.sortOrder !== undefined) existing.sortOrder = entry.sortOrder;
        if (entry.iconHint !== undefined) existing.iconHint = entry.iconHint;
        if (entry.expected !== undefined) existing.expected = entry.expected;
        if (entry.terms?.defaultWindowLabel !== undefined) {
          existing.terms = {
            ...existing.terms,
            defaultWindowLabel: entry.terms.defaultWindowLabel,
          };
        }
        if (entry.terms?.via !== undefined) {
          existing.terms = {
            ...existing.terms,
            via: entry.terms.via,
          };
        }
        if (entry.aliases && entry.aliases.length > 0) {
          const merged = new Set<string>(existing.aliases);
          for (const a of entry.aliases) merged.add(a);
          existing.aliases = [...merged];
        }
      } else {
        byKey.set(entry.key, {
          key: entry.key,
          label: entry.label ?? entry.key,
          sortOrder: entry.sortOrder ?? 1000,
          iconHint: entry.iconHint,
          aliases: [...(entry.aliases ?? [])],
          expected: entry.expected ?? false,
          terms: {
            ...(entry.terms ?? {}),
          },
        });
      }
    }
  }

  // Build the alias → canonical-key map.  Identity aliases are added
  // automatically (a provider is always its own canonical key).
  const aliasToKey = new Map<string, string>();
  for (const cfg of byKey.values()) {
    aliasToKey.set(cfg.key.toLowerCase(), cfg.key);
    for (const alias of cfg.aliases) {
      const lowered = alias.toLowerCase();
      // Manifest wins on collisions: last-write-wins after the defaults have
      // been applied, so a manifest entry's aliases override an earlier
      // defaults' alias when the same alias string is claimed twice.
      aliasToKey.set(lowered, cfg.key);
    }
  }

  const providers = [...byKey.values()].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label);
  });

  return {
    providers,
    aliasToKey,
    byKey,
    fromInfisical: !!manifest,
  };
}

/**
 * Read the live manifest from the app-settings service and resolve against
 * the compiled defaults.  Falls back to defaults on missing / malformed
 * knob.  This is the function the quota-windows route calls per request.
 */
export function loadResolvedProviderManifest(): ResolvedProviderManifest {
  const raw = appSettings.get(PROVIDER_MANIFEST_KEY);
  if (raw == null || raw.trim() === "") {
    return resolveProviderManifest(null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[provider-manifest] malformed JSON in ${PROVIDER_MANIFEST_KEY}: ${message}. ` +
        "Falling back to compiled defaults.",
    );
    return resolveProviderManifest(null);
  }
  const validated = parseProviderManifest(parsed);
  if (!validated) return resolveProviderManifest(null);
  return resolveProviderManifest(validated);
}

/**
 * Normalize a raw event `provider` value onto a canonical key using the
 * resolved manifest.  Unknown values pass through lowercased.
 */
export function normalizeProviderKey(
  raw: string | null | undefined,
  manifest: ResolvedProviderManifest,
): string {
  const trimmed = String(raw ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  return manifest.aliasToKey.get(trimmed) ?? trimmed;
}