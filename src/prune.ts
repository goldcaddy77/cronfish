// Per-run retention. Logs accumulate under `.cronfish/logs/<slug>/<id>.log`
// and ledger rows accumulate in the SQLite db forever; on an always-on
// machine both grow unbounded. `pruneLogs` is the pure, fs-only core (no DB,
// no launchd) and `pruneLedger` is the DB-only sibling — both trivially
// testable: hand them retention settings, get back a report of what was (or
// would be) deleted.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { logsRoot } from "./store/paths.ts";

export interface SlugRetention {
  // Delete logs whose mtime is older than this many days.
  maxAgeDays?: number;
  // Keep at most this many most-recent logs per slug; delete older ones.
  maxRuns?: number;
}

export interface PruneOptions {
  consumerRoot: string;
  // Default retention applied to every slug.
  global: SlugRetention;
  // Per-slug overrides, keyed by forward-slash slug (e.g. "email/triage-ts").
  // A slug present here fully replaces `global` for that slug.
  perSlug?: Record<string, SlugRetention>;
  // Limit pruning to a single slug.
  onlySlug?: string;
  // Report what would be deleted without touching disk.
  dryRun?: boolean;
  // Injectable clock for tests (ms since epoch). Defaults to Date.now().
  nowMs?: number;
}

export interface PruneSlugResult {
  slug: string;
  deleted: string[]; // absolute paths
  bytesFreed: number;
  kept: number;
}

export interface PruneReport {
  slugs: PruneSlugResult[];
  totalDeleted: number;
  totalBytes: number;
}

interface LogFile {
  path: string; // absolute
  mtimeMs: number;
  size: number;
}

// Recursively collect every `*.log` file under `dir`, grouped by the slug its
// parent directory encodes (path relative to the logs root, forward slashes).
// `ui.log` and anything sitting directly in the logs root (parent === root) is
// skipped — those are daemon logs, not per-run logs.
function collectBySlug(logsDir: string): Map<string, LogFile[]> {
  const bySlug = new Map<string, LogFile[]>();
  const visit = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
        continue;
      }
      if (!e.name.endsWith(".log")) continue;
      const slug = relative(logsDir, dir).split("\\").join("/");
      if (slug === "") continue; // ui.log etc. live at the root — not per-run
      let st: import("node:fs").Stats;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const list = bySlug.get(slug) ?? [];
      list.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      bySlug.set(slug, list);
    }
  };
  visit(logsDir);
  return bySlug;
}

// Decide which of a slug's log files to delete: anything older than maxAgeDays,
// plus anything beyond the newest maxRuns. Returns the doomed files.
function selectVictims(
  files: LogFile[],
  retention: SlugRetention,
  nowMs: number,
): LogFile[] {
  const doomed = new Set<LogFile>();
  if (retention.maxAgeDays !== undefined) {
    const cutoff = nowMs - retention.maxAgeDays * 86_400_000;
    for (const f of files) if (f.mtimeMs < cutoff) doomed.add(f);
  }
  if (retention.maxRuns !== undefined) {
    const newestFirst = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of newestFirst.slice(retention.maxRuns)) doomed.add(f);
  }
  return [...doomed];
}

export function pruneLogs(opts: PruneOptions): PruneReport {
  const logsDir = logsRoot(opts.consumerRoot);
  const nowMs = opts.nowMs ?? Date.now();
  const bySlug = collectBySlug(logsDir);

  const slugs: PruneSlugResult[] = [];
  for (const [slug, files] of [...bySlug.entries()].sort()) {
    if (opts.onlySlug && slug !== opts.onlySlug) continue;
    const retention = opts.perSlug?.[slug] ?? opts.global;
    // No limits set for this slug → nothing to do.
    if (retention.maxAgeDays === undefined && retention.maxRuns === undefined) {
      continue;
    }
    const victims = selectVictims(files, retention, nowMs);
    if (victims.length === 0) continue;
    let bytesFreed = 0;
    const deleted: string[] = [];
    for (const v of victims) {
      if (!opts.dryRun) {
        try {
          rmSync(v.path);
        } catch {
          continue; // already gone / racing runner — skip silently
        }
      }
      deleted.push(v.path);
      bytesFreed += v.size;
    }
    slugs.push({
      slug,
      deleted,
      bytesFreed,
      kept: files.length - deleted.length,
    });
  }

  return {
    slugs,
    totalDeleted: slugs.reduce((n, s) => n + s.deleted.length, 0),
    totalBytes: slugs.reduce((n, s) => n + s.bytesFreed, 0),
  };
}

// --- Ledger row pruning ---
//
// The row-side sibling of pruneLogs: deletes cron_invocations,
// cron_run_requests, and cron_missed_alerts rows older than the retention
// window. Only maxAgeDays applies (maxRuns is a log-file concept); the same
// per-slug > global resolution decides each job's window. cron_jobs rows are
// NEVER deleted — history tombstones stay forever.

// A 'running' row younger than this is (or may be) a genuinely in-flight run
// — never delete it, whatever the window says. Older 'running' rows are
// crash debris and prune normally.
export const RUNNING_PROTECT_MS = 86_400_000;

// The ledger-prune DB body now lives in SqliteStore.pruneLedger (the store
// seam owns every DB operation). The option/report SHAPES live in the store
// interface; re-exported here so existing `from "./prune"` type imports keep
// working. RUNNING_PROTECT_MS stays here — it is the shared retention constant
// the store impl imports.
export type {
  LedgerPruneOptions,
  LedgerPruneReport,
} from "./store/interface.ts";
import type { LedgerPruneReport } from "./store/interface.ts";

export function ledgerPruneTotal(r: LedgerPruneReport): number {
  return r.invocations + r.runRequests + r.missedAlerts;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
