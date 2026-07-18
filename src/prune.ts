// Per-run retention. Logs accumulate under `.cronfish/logs/<slug>/<id>.log`
// and ledger rows accumulate in the SQLite db forever; on an always-on
// machine both grow unbounded. `pruneLogs` is the pure, fs-only core (no DB,
// no launchd) and `pruneLedger` is the DB-only sibling — both trivially
// testable: hand them retention settings, get back a report of what was (or
// would be) deleted.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { logsRoot } from "./db.ts";

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

export interface LedgerPruneOptions {
  db: Database;
  // Default retention applied to every slug (only maxAgeDays matters here).
  global: SlugRetention;
  // Per-slug overrides; a slug present here fully replaces `global`.
  perSlug?: Record<string, SlugRetention>;
  // Limit pruning to a single slug.
  onlySlug?: string;
  // Report what would be deleted without touching the db.
  dryRun?: boolean;
  // Injectable clock for tests (ms since epoch). Defaults to Date.now().
  nowMs?: number;
}

export interface LedgerPruneReport {
  invocations: number;
  runRequests: number;
  missedAlerts: number;
}

export function pruneLedger(opts: LedgerPruneOptions): LedgerPruneReport {
  const nowMs = opts.nowMs ?? Date.now();
  const runningCutoff = new Date(nowMs - RUNNING_PROTECT_MS).toISOString();
  const report: LedgerPruneReport = {
    invocations: 0,
    runRequests: 0,
    missedAlerts: 0,
  };

  const jobs = opts.db
    .query("SELECT id, slug FROM cron_jobs ORDER BY slug")
    .all() as { id: number; slug: string }[];

  // The doomed-invocation predicate, shared by count/null-refs/delete so the
  // three can never disagree. Bind: $job, $cutoff, $running_cutoff.
  const doomedInv = `job_id = $job AND started_at < $cutoff
      AND NOT (status = 'running' AND started_at >= $running_cutoff)`;

  const work = (): void => {
    for (const job of jobs) {
      if (opts.onlySlug && job.slug !== opts.onlySlug) continue;
      const retention = opts.perSlug?.[job.slug] ?? opts.global;
      if (retention.maxAgeDays === undefined) continue;
      const cutoff = new Date(
        nowMs - retention.maxAgeDays * 86_400_000,
      ).toISOString();
      const p = { $job: job.id, $cutoff: cutoff };

      if (opts.dryRun) {
        const count = (sql: string, params: Record<string, unknown>): number =>
          (opts.db.query(sql).get(params) as { n: number }).n;
        report.missedAlerts += count(
          "SELECT COUNT(*) AS n FROM cron_missed_alerts WHERE job_id = $job AND fired_at < $cutoff",
          p,
        );
        report.runRequests += count(
          "SELECT COUNT(*) AS n FROM cron_run_requests WHERE job_id = $job AND requested_at < $cutoff",
          p,
        );
        report.invocations += count(
          `SELECT COUNT(*) AS n FROM cron_invocations WHERE ${doomedInv}`,
          { ...p, $running_cutoff: runningCutoff },
        );
        continue;
      }

      report.missedAlerts += opts.db
        .prepare(
          "DELETE FROM cron_missed_alerts WHERE job_id = $job AND fired_at < $cutoff",
        )
        .run(p).changes;
      report.runRequests += opts.db
        .prepare(
          "DELETE FROM cron_run_requests WHERE job_id = $job AND requested_at < $cutoff",
        )
        .run(p).changes;
      // A surviving run request may still reference a doomed invocation
      // (foreign_keys=ON would abort the delete) — sever the link first.
      const pInv = { ...p, $running_cutoff: runningCutoff };
      opts.db
        .prepare(
          `UPDATE cron_run_requests SET invocation_id = NULL
           WHERE job_id = $job AND invocation_id IN
             (SELECT id FROM cron_invocations WHERE ${doomedInv})`,
        )
        .run(pInv);
      report.invocations += opts.db
        .prepare(`DELETE FROM cron_invocations WHERE ${doomedInv}`)
        .run(pInv).changes;
    }
  };

  if (opts.dryRun) work();
  else opts.db.transaction(work)();
  return report;
}

export function ledgerPruneTotal(r: LedgerPruneReport): number {
  return r.invocations + r.runRequests + r.missedAlerts;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
