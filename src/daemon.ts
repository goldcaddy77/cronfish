// Cronfish v2 daemon — the tick loop (docs/v2-daemon.md).
//
// One foreground process, 1 Hz. Each tick: mtime-scan cron/ and sync changed
// files into the ledger, dispatch every due job by spawning the existing
// runner as a child process, drain `cron run` requests, beat the heartbeat.
// The daemon decides WHEN a job runs; the runner keeps owning HOW (locks,
// logs, retries, invocation rows, alerts). Job code never executes in this
// process — a hung or OOMing job can't take the scheduler down.
//
// `tickOnce(ctx, now)` is the whole brain and is pure-ish: tests drive it
// with a fake clock and a stub spawn function. `runDaemon()` is the thin
// wall-clock loop around it (started via `cronfish daemon`).

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  beatDaemonHeartbeat,
  claimPendingRunRequests,
  listDueJobs,
  listJobSyncState,
  markDeleted,
  openDb,
  setJobNextRun,
  upsertJob,
  type InvocationTrigger,
  type JobSyncStateRow,
} from "./db.ts";
import { loadJob, slugFromPath, walkJobFiles } from "./jobs.ts";
import { computeNextRun } from "./next-run.ts";
import pkg from "../package.json" with { type: "json" };

// A due job older than this at dispatch time is a post-downtime catch-up run
// (trigger='catchup'), not a normally-scheduled one. Missed occurrences
// always coalesce to ONE run regardless — next_run is a single timestamp and
// dispatch recomputes it from now.
export const CATCHUP_GRACE_MS = 60_000;

export const TICK_MS = 1_000;

export interface SpawnRequest {
  slug: string;
  jobPath: string;
  trigger: InvocationTrigger;
  // The planned fire time this dispatch fulfills → invocation.scheduled_for.
  scheduledFor?: string;
  // The `cron run` request this dispatch drains → run-request linkage.
  runRequestId?: number;
}

export type SpawnFn = (req: SpawnRequest) => void;

export interface DaemonCtx {
  db: Database;
  consumerRoot: string;
  cronDir: string;
  spawn: SpawnFn;
  pid: number;
  startedAt: string;
  version?: string;
  log?: (msg: string) => void;
}

function warn(ctx: DaemonCtx, msg: string): void {
  (ctx.log ?? ((m: string) => console.error(m)))(`[daemon] ${msg}`);
}

// --- 1. File sync (mtime scan) ---
//
// Stat every job file; only files whose mtime differs from the stored
// file_mtime (or that have no row) get re-parsed and upserted, then their
// next_run_at recomputed via computeNextRun(schedule, last_run_at, now) —
// which IS the locked schedule-change rule. Files gone from disk →
// state='deleted' (row kept forever, never runs).
function syncFiles(ctx: DaemonCtx, now: Date): void {
  const files = walkJobFiles(ctx.cronDir);
  const stored = new Map<string, JobSyncStateRow>();
  for (const row of listJobSyncState(ctx.db)) stored.set(row.slug, row);

  const presentSlugs: string[] = [];
  for (const path of files) {
    const slug = slugFromPath(ctx.cronDir, path);
    presentSlugs.push(slug);
    let mtimeIso: string;
    try {
      mtimeIso = new Date(statSync(path).mtimeMs).toISOString();
    } catch {
      continue; // raced a deletion; next tick's markDeleted handles it
    }
    const prev = stored.get(slug);
    // Unchanged-but-unscheduled covers rows written by a v1 sync (no
    // file_mtime → treated as changed anyway) and any row whose next_run
    // write was lost: an active non-manual row must never sit at NULL.
    const changed = !prev || prev.file_mtime !== mtimeIso;
    const unscheduled =
      !!prev &&
      prev.state === "active" &&
      prev.next_run_at === null &&
      prev.schedule_kind !== "manual" &&
      prev.schedule_kind !== "once";
    if (!changed && !unscheduled) continue;
    try {
      if (changed) {
        const meta = loadJob(path, slug, ctx.cronDir);
        upsertJob(ctx.db, meta, mtimeIso);
        const jobId = requireJobId(ctx.db, slug);
        const next = meta.enabled
          ? computeNextRun(
              meta.schedule,
              prev?.last_run_at ? new Date(prev.last_run_at) : null,
              now,
            )
          : null;
        setJobNextRun(ctx.db, jobId, next ? next.toISOString() : null);
      } else {
        // unscheduled: recompute from the stored schedule, no re-parse.
        const next = computeNextRun(
          prev!.schedule,
          prev!.last_run_at ? new Date(prev!.last_run_at) : null,
          now,
        );
        setJobNextRun(ctx.db, prev!.id, next ? next.toISOString() : null);
      }
    } catch (e) {
      // A broken file must not kill the tick — and must not clobber the
      // existing row: leave state/schedule as-is until the file parses again.
      warn(ctx, `sync ${slug}: ${(e as Error).message}`);
    }
  }

  markDeleted(ctx.db, presentSlugs);
}

function requireJobId(db: Database, slug: string): number {
  const row = db
    .query("SELECT id FROM cron_jobs WHERE slug = $slug")
    .get({ $slug: slug }) as { id: number } | undefined;
  if (!row) throw new Error(`job row missing after upsert: ${slug}`);
  return row.id;
}

// --- 2. Dispatch due jobs ---
//
// next_run is advanced BEFORE spawning (computeNextRun from now, so N missed
// occurrences collapse to exactly one overdue run) — a spawn failure can log
// every interval but can never hot-loop at 1 Hz.
function dispatchDue(ctx: DaemonCtx, now: Date): void {
  for (const job of listDueJobs(ctx.db, now.toISOString())) {
    try {
      const next = computeNextRun(job.schedule, now, now);
      setJobNextRun(ctx.db, job.id, next ? next.toISOString() : null);
    } catch (e) {
      // Unparseable schedule on a due row — park it (NULL never re-dispatches)
      // until the next file edit resyncs it.
      warn(ctx, `advance ${job.slug}: ${(e as Error).message}`);
      setJobNextRun(ctx.db, job.id, null);
    }
    try {
      if (!job.file_path) {
        warn(ctx, `dispatch ${job.slug}: no file_path on ledger row — skipped`);
        continue;
      }
      const overdueMs = now.getTime() - Date.parse(job.next_run_at);
      const trigger: InvocationTrigger =
        overdueMs > CATCHUP_GRACE_MS ? "catchup" : "schedule";
      ctx.spawn({
        slug: job.slug,
        jobPath: job.file_path,
        trigger,
        scheduledFor: job.next_run_at,
      });
    } catch (e) {
      warn(ctx, `dispatch ${job.slug}: ${(e as Error).message}`);
    }
  }
}

// --- 3. Drain `cron run` requests ---
//
// claimPendingRunRequests marks picked_up_at atomically, so a request is
// spawned at most once. The runner links the invocation row back via
// CRONFISH_RUN_REQUEST_ID (it owns the invocation's creation).
function drainRunRequests(ctx: DaemonCtx): void {
  for (const req of claimPendingRunRequests(ctx.db)) {
    try {
      if (!req.file_path) {
        warn(ctx, `run request #${req.id} (${req.slug}): job file gone — skipped`);
        continue;
      }
      ctx.spawn({
        slug: req.slug,
        jobPath: req.file_path,
        trigger: "manual",
        runRequestId: req.id,
      });
    } catch (e) {
      warn(ctx, `run request #${req.id} (${req.slug}): ${(e as Error).message}`);
    }
  }
}

// One full tick. Every phase is fenced — an error in one job's sync or
// dispatch logs to stderr and the loop keeps going.
export function tickOnce(ctx: DaemonCtx, now: Date): void {
  try {
    syncFiles(ctx, now);
  } catch (e) {
    warn(ctx, `file sync: ${(e as Error).message}`);
  }
  try {
    dispatchDue(ctx, now);
  } catch (e) {
    warn(ctx, `dispatch: ${(e as Error).message}`);
  }
  try {
    drainRunRequests(ctx);
  } catch (e) {
    warn(ctx, `run requests: ${(e as Error).message}`);
  }
  try {
    beatDaemonHeartbeat(ctx.db, {
      pid: ctx.pid,
      startedAt: ctx.startedAt,
      version: ctx.version,
    });
  } catch (e) {
    warn(ctx, `heartbeat: ${(e as Error).message}`);
  }
}

// Production spawn: the exact invocation shape launchd used —
// `bun src/runner.ts <abs job path>` with the consumer root + trigger in env.
// Children are tracked but never awaited; the runner owns its own lifecycle.
export function makeRunnerSpawn(consumerRoot: string): SpawnFn {
  const runnerTs = new URL("./runner.ts", import.meta.url).pathname;
  const children = new Set<number>();
  return (req) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CRONFISH_CONSUMER_ROOT: consumerRoot,
      CRONFISH_TRIGGER: req.trigger,
    };
    if (req.scheduledFor) env.CRONFISH_SCHEDULED_FOR = req.scheduledFor;
    if (req.runRequestId !== undefined) {
      env.CRONFISH_RUN_REQUEST_ID = String(req.runRequestId);
    }
    const proc = Bun.spawn(["bun", runnerTs, req.jobPath], {
      cwd: consumerRoot,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    children.add(proc.pid);
    console.error(
      `[daemon] spawn ${req.slug} trigger=${req.trigger} pid=${proc.pid}`,
    );
    proc.exited
      .catch(() => {})
      .finally(() => {
        children.delete(proc.pid);
      });
  };
}

// Foreground loop for `cronfish daemon`. SIGTERM/SIGINT stop the ticking and
// exit; in-flight children are independent runner processes and are left
// running (they hold their own locks and finish their own ledger rows).
export async function runDaemon(opts: { consumerRoot: string }): Promise<void> {
  const consumerRoot = opts.consumerRoot;
  const db = openDb(consumerRoot);
  const ctx: DaemonCtx = {
    db,
    consumerRoot,
    cronDir: join(consumerRoot, "cron"),
    spawn: makeRunnerSpawn(consumerRoot),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: pkg.version,
  };

  let running = true;
  const stop = (sig: NodeJS.Signals): void => {
    if (!running) return;
    running = false;
    console.error(
      `[daemon] ${sig} — stopping tick loop (children left running)`,
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  console.error(
    `[daemon] cronfish ${pkg.version} pid=${ctx.pid} consumer=${consumerRoot} tick=${TICK_MS}ms`,
  );
  while (running) {
    const t0 = Date.now();
    tickOnce(ctx, new Date());
    const elapsed = Date.now() - t0;
    if (elapsed > TICK_MS) {
      console.error(`[daemon] slow tick: ${elapsed}ms`);
    }
    await Bun.sleep(Math.max(0, TICK_MS - elapsed));
  }
  try {
    db.close();
  } catch {}
}
