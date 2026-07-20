// Store-agnostic open factory — the one place backend selection happens.
//
// `openStore`/`tryOpenStore` keep their exact pre-Postgres signatures so ZERO
// call site changes: every consumer (daemon, runner, watchdog, ui/server, cli)
// still calls `openStore(consumerRoot)` / `tryOpenStore(consumerRoot, opts)`.
// The backend is read from `.cronfish.json`'s `store` block (config.ts,
// tolerant parser) and dispatched here — sqlite (the default) → the unchanged
// SqliteStore path; postgres → PostgresStore.open. Fail-soft `tryOpenStore`
// semantics hold for BOTH backends: a missing sqlite file OR an unreachable /
// misconfigured postgres returns null instead of throwing.

import { loadStoreConfig, resolveStoreUrl } from "../config.ts";
import type { CronStore } from "./interface.ts";
import { PostgresStore } from "./postgres.ts";
import { openSqliteStore, tryOpenSqliteStore } from "./sqlite.ts";

// Open the consumer's store, dispatching on the configured backend. Migrates to
// head. Throws on a hard failure (unreachable postgres, invalid config) — same
// as the SQLite path always did for a genuinely broken db.
export async function openStore(consumerRoot: string): Promise<CronStore> {
  const cfg = loadStoreConfig(consumerRoot);
  if (cfg.type === "postgres") {
    return PostgresStore.open({
      url: resolveStoreUrl(cfg),
      schema: cfg.schema,
    });
  }
  return openSqliteStore(consumerRoot);
}

// Fail-soft open for read paths. Returns null on any open failure for BOTH
// backends — a missing sqlite file, an unreachable postgres, a config that
// resolves to a missing env var. The `readonly` flag is honored only for
// sqlite (a peek at a possibly-pre-v6 file); postgres always migrates, so a
// readonly postgres open just opens+migrates normally.
export async function tryOpenStore(
  consumerRoot: string,
  opts: { readonly?: boolean } = {},
): Promise<CronStore | null> {
  const cfg = loadStoreConfig(consumerRoot);
  if (cfg.type === "postgres") {
    try {
      return await PostgresStore.open({
        url: resolveStoreUrl(cfg),
        schema: cfg.schema,
      });
    } catch {
      return null;
    }
  }
  return tryOpenSqliteStore(consumerRoot, opts);
}
