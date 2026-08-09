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

import { existsSync } from "node:fs";
import { loadStoreConfig, resolveStoreUrl } from "../config.ts";
import type { CronStore } from "./interface.ts";
import { dbPath } from "./paths.ts";
import { PostgresStore } from "./postgres.ts";
import { openSqliteStore, tryOpenSqliteStore } from "./sqlite.ts";

// Is there definitively no store to read — i.e. may a caller skip opening one
// without risking a false "nothing here"? This only ever answers true for
// SQLite, where absence is a local fact: no file, no store, and opening one
// would CREATE it, which read paths must never do on a fresh consumer.
//
// For Postgres the honest answer is "ask the server". The store is remote, so
// no local path can prove its absence; callers go through `tryOpenStore`,
// which is already fail-soft when the server is unreachable.
//
// This exists because call sites used to inline `existsSync(dbPath(root))` as
// a stand-in for "is there a store?". That predicate is backend-blind, and on
// a Postgres consumer it is not merely wrong but PERMANENTLY wrong: the SQLite
// file it looks for will never exist, so every guarded read path reports empty
// forever, without erroring. `cronfish status` printed "daemon: not running
// (no heartbeat)" for 20 days at a daemon that was ticking at 1 Hz throughout
// (CAD-1104). Backend selection belongs in this file, which already owns it —
// never at a call site.
export function storeDefinitelyAbsent(consumerRoot: string): boolean {
  const cfg = loadStoreConfig(consumerRoot);
  if (cfg.type === "postgres") return false;
  return !existsSync(dbPath(consumerRoot));
}

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
