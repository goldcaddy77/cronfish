// Shared config helpers. The bundle-prefix formula has to be identical
// everywhere a launchd label is computed — cli.ts (install/bootout) and
// runner.ts (one-time self-removal) both derive labels from it, so it lives
// here rather than being duplicated and drifting.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SlugRetention } from "./prune.ts";

export function defaultBundlePrefix(consumerRoot: string): string {
  return `com.cronfish.${basename(consumerRoot)}`;
}

// Tolerant prefix read for non-CLI callers (the runner). Returns the default
// on a missing/unparseable .cronfish.json — the strict validation that the
// CLI applies at install time has already gated the value by the time a job
// is running, so the runner only needs to reproduce the same string.
export function loadBundlePrefix(consumerRoot: string): string {
  const def = defaultBundlePrefix(consumerRoot);
  const path = join(consumerRoot, ".cronfish.json");
  if (!existsSync(path)) return def;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      bundle_prefix?: string;
    };
    return (parsed.bundle_prefix ?? "").trim() || def;
  } catch {
    return def;
  }
}

// --- Retention ---
//
// The `.cronfish.json` retention block gates BOTH log-file pruning and ledger
// row pruning. The strict parser lives here (not cli.ts) because the daemon's
// daily housekeeping needs the same config resolution without importing the
// CLI.

export interface RetentionConfig {
  max_age_days?: number;
  max_runs?: number;
  per_slug?: Record<string, { max_age_days?: number; max_runs?: number }>;
}

function asRetentionInt(label: string, val: unknown): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
    throw new Error(`.cronfish.json: ${label} must be a positive integer`);
  }
  return val;
}

export function parseRetention(raw: unknown): RetentionConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`.cronfish.json: retention must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const out: RetentionConfig = {
    max_age_days: asRetentionInt("retention.max_age_days", r.max_age_days),
    max_runs: asRetentionInt("retention.max_runs", r.max_runs),
  };
  if (r.per_slug !== undefined) {
    if (typeof r.per_slug !== "object" || r.per_slug === null) {
      throw new Error(`.cronfish.json: retention.per_slug must be an object`);
    }
    out.per_slug = {};
    for (const [slug, v] of Object.entries(r.per_slug as object)) {
      const o = (v ?? {}) as Record<string, unknown>;
      out.per_slug[slug] = {
        max_age_days: asRetentionInt(
          `retention.per_slug.${slug}.max_age_days`,
          o.max_age_days,
        ),
        max_runs: asRetentionInt(
          `retention.per_slug.${slug}.max_runs`,
          o.max_runs,
        ),
      };
    }
  }
  return out;
}

// Translate the snake_case config block into the prune core's shape.
export function retentionToPrune(r: RetentionConfig): {
  global: SlugRetention;
  perSlug: Record<string, SlugRetention>;
} {
  const global: SlugRetention = {
    maxAgeDays: r.max_age_days,
    maxRuns: r.max_runs,
  };
  const perSlug: Record<string, SlugRetention> = {};
  for (const [slug, v] of Object.entries(r.per_slug ?? {})) {
    perSlug[slug] = { maxAgeDays: v.max_age_days, maxRuns: v.max_runs };
  }
  return { global, perSlug };
}

// Tolerant retention read for the daemon's housekeeping (mirrors
// loadBundlePrefix): null when no retention is configured or the file is
// missing/unparseable — auto-prune is strictly opt-in, so any doubt means
// "don't delete anything".
export function loadRetention(consumerRoot: string): {
  global: SlugRetention;
  perSlug: Record<string, SlugRetention>;
} | null {
  const path = join(consumerRoot, ".cronfish.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      retention?: unknown;
    };
    const retention = parseRetention(parsed.retention);
    return retention ? retentionToPrune(retention) : null;
  } catch {
    return null;
  }
}

// --- Store backend selection ---
//
// The `.cronfish.json` `store` block picks the backend. Absent/unparseable →
// the default SQLite store (byte-identical to pre-config behavior), so no
// existing deployment changes. Postgres needs a connection URL; to keep DB
// URLs out of a committed config file, the URL may be given by env-var NAME via
// `url_env` (resolved at open time) instead of an inline `url`.
//
//   { "store": { "type": "postgres", "url_env": "CRONFISH_PG_URL", "schema": "cron" } }
//
// A tolerant parser (loadStoreConfig, mirrors loadBundlePrefix/loadRetention)
// backs the runtime; a strict parser (parseStoreConfig, mirrors parseRetention)
// validates at CLI/install time.

export type StoreConfig =
  | { type: "sqlite" }
  | { type: "postgres"; url?: string; url_env?: string; schema: string };

export const DEFAULT_STORE_CONFIG: StoreConfig = { type: "sqlite" };

export function parseStoreConfig(raw: unknown): StoreConfig {
  if (raw === undefined || raw === null) return DEFAULT_STORE_CONFIG;
  if (typeof raw !== "object") {
    throw new Error(`.cronfish.json: store must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const type = r.type ?? "sqlite";
  if (type === "sqlite") return { type: "sqlite" };
  if (type !== "postgres") {
    throw new Error(
      `.cronfish.json: store.type must be "sqlite" or "postgres"`,
    );
  }
  const url = r.url;
  const urlEnv = r.url_env;
  if (url !== undefined && typeof url !== "string") {
    throw new Error(`.cronfish.json: store.url must be a string`);
  }
  if (urlEnv !== undefined && typeof urlEnv !== "string") {
    throw new Error(`.cronfish.json: store.url_env must be a string`);
  }
  if (url === undefined && urlEnv === undefined) {
    throw new Error(
      `.cronfish.json: store.type "postgres" requires store.url or store.url_env`,
    );
  }
  const schema = r.schema ?? "cron";
  if (typeof schema !== "string" || schema.length === 0) {
    throw new Error(`.cronfish.json: store.schema must be a non-empty string`);
  }
  return { type: "postgres", url, url_env: urlEnv, schema };
}

// Resolve the effective Postgres connection URL, reading `url_env` from the
// environment when set. Throws when a named env var is missing so a
// misconfigured deployment fails loudly at open time (the strict path) — the
// tolerant openers below catch it and fall back / return null as appropriate.
export function resolveStoreUrl(cfg: StoreConfig): string {
  if (cfg.type !== "postgres") {
    throw new Error("resolveStoreUrl called on a non-postgres store config");
  }
  if (cfg.url_env) {
    const fromEnv = process.env[cfg.url_env];
    if (!fromEnv) {
      throw new Error(
        `.cronfish.json: store.url_env "${cfg.url_env}" is not set in the environment`,
      );
    }
    return fromEnv;
  }
  if (cfg.url) return cfg.url;
  throw new Error(`.cronfish.json: postgres store has neither url nor url_env`);
}

// Tolerant store-config read (mirrors loadRetention): the default SQLite config
// on a missing/unparseable file, so a broken config never silently swaps
// backends — it degrades to the safe default.
export function loadStoreConfig(consumerRoot: string): StoreConfig {
  const path = join(consumerRoot, ".cronfish.json");
  if (!existsSync(path)) return DEFAULT_STORE_CONFIG;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      store?: unknown;
    };
    return parseStoreConfig(parsed.store);
  } catch {
    return DEFAULT_STORE_CONFIG;
  }
}
