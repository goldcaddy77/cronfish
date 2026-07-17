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

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  beatDaemonHeartbeat,
  claimPendingRunRequests,
  clearRunRequestClaim,
  getDaemonHeartbeat,
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
import { runWatchdog, type WatchdogDecision } from "./watchdog.ts";
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
  // Jobs parked (next_run_at=NULL) because their stored schedule stopped
  // parsing / has no future occurrence. One warn per park, then silence —
  // cleared when the job file changes. Lazily created; per-process only
  // (a restart re-warns once, which is fine).
  parked?: Map<number, string>;
}

function parkedMap(ctx: DaemonCtx): Map<number, string> {
  return (ctx.parked ??= new Map());
}

function warn(ctx: DaemonCtx, msg: string): void {
  (ctx.log ?? ((m: string) => console.error(m)))(`[daemon] ${msg}`);
}

// --- 1. File sync (size+mtime scan) ---
//
// Stat every job file; only files whose size+mtime differ from the stored
// file_size/file_mtime (or that have no row) get re-parsed and upserted, then
// their next_run_at recomputed via computeNextRun(schedule, last_run_at, now)
// — which IS the locked schedule-change rule. (Size is part of the key
// because an mtime-preserving replacement — `cp -p` — keeps mtime intact.)
// One-time jobs (run_at, no schedule) map to schedule_kind='once' with
// next_run_at = run_at, NULL once executed_at is stamped. Files gone from
// disk → state='deleted' (row kept forever, never runs).
function syncFiles(ctx: DaemonCtx, now: Date): void {
  const files = walkJobFiles(ctx.cronDir);
  const stored = new Map<string, JobSyncStateRow>();
  for (const row of listJobSyncState(ctx.db)) stored.set(row.slug, row);
  const parked = parkedMap(ctx);

  const presentSlugs: string[] = [];
  for (const path of files) {
    const slug = slugFromPath(ctx.cronDir, path);
    presentSlugs.push(slug);
    let mtimeIso: string;
    let sizeBytes: number;
    try {
      const st = statSync(path);
      mtimeIso = new Date(st.mtimeMs).toISOString();
      sizeBytes = st.size;
    } catch {
      continue; // raced a deletion; next tick's markDeleted handles it
    }
    const prev = stored.get(slug);
    // Unchanged-but-unscheduled covers rows written by a v1 sync (no
    // file_mtime → treated as changed anyway) and any row whose next_run
    // write was lost: an active non-manual row must never sit at NULL.
    // Parked rows (unparseable schedule) are excluded — re-trying them every
    // tick is 1 Hz log spam; only a file edit un-parks.
    const changed =
      !prev || prev.file_mtime !== mtimeIso || prev.file_size !== sizeBytes;
    const unscheduled =
      !!prev &&
      prev.state === "active" &&
      prev.next_run_at === null &&
      prev.schedule_kind !== "manual" &&
      prev.schedule_kind !== "once" &&
      !parked.has(prev.id);
    if (!changed && !unscheduled) continue;
    try {
      if (changed) {
        const meta = loadJob(path, slug, ctx.cronDir);
        upsertJob(ctx.db, meta, mtimeIso, sizeBytes);
        const jobId = requireJobId(ctx.db, slug);
        parked.delete(jobId); // an edit is the un-park signal
        let next: Date | null;
        if (meta.oneTime) {
          // One-shot: next_run = run_at exactly once. Already-executed (or
          // missing run_at, which loadJob rejects anyway) → never scheduled.
          // Late fires are the RUNNER's call — it re-asserts grace_seconds
          // at run time and refuses past-grace with a sentinel.
          next =
            meta.enabled && !meta.executedAt && meta.runAtMs !== undefined
              ? new Date(meta.runAtMs)
              : null;
        } else {
          next = meta.enabled
            ? computeNextRun(
                meta.schedule,
                prev?.last_run_at ? new Date(prev.last_run_at) : null,
                now,
              )
            : null;
        }
        setJobNextRun(ctx.db, jobId, next ? next.toISOString() : null);
      } else {
        // unscheduled: recompute from the stored schedule, no re-parse.
        try {
          const next = computeNextRun(
            prev!.schedule,
            prev!.last_run_at ? new Date(prev!.last_run_at) : null,
            now,
          );
          setJobNextRun(ctx.db, prev!.id, next ? next.toISOString() : null);
        } catch (e) {
          // Stored schedule no longer computes (e.g. cron expr with no
          // future occurrence). Park it — one warn, then quiet until edited.
          parked.set(prev!.id, (e as Error).message);
          warn(
            ctx,
            `sync ${slug}: ${(e as Error).message} — parked until the file is edited`,
          );
        }
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
  const parked = parkedMap(ctx);
  for (const job of listDueJobs(ctx.db, now.toISOString())) {
    // next_run is advanced BEFORE spawning — the deliberate at-most-once
    // trade-off: a crash between the advance and the spawn DROPS this slot
    // (the run simply doesn't happen and next_run points at the future).
    // That's preferred over advance-after-spawn, which can double-fire; the
    // in-daemon missed-run check catches a dropped slot and alerts.
    let nextIso: string | null = null;
    let scheduleErr: string | null = null;
    if (job.schedule_kind === "once") {
      // One-shot: never recurs. NULL immediately so it can never
      // re-dispatch; the runner owns executed_at stamping + archival.
      nextIso = null;
    } else {
      try {
        const next = computeNextRun(job.schedule, now, now);
        nextIso = next ? next.toISOString() : null;
      } catch (e) {
        // Unparseable schedule on a due row — park it (NULL never
        // re-dispatches) until the next file edit resyncs it.
        scheduleErr = (e as Error).message;
        nextIso = null;
      }
    }
    try {
      setJobNextRun(ctx.db, job.id, nextIso);
    } catch (e) {
      // DB error ≠ schedule error: leave next_run_at untouched and do NOT
      // spawn — the row stays due and the next tick retries the whole step.
      // (Spawning here with the advance unrecorded would double-run.)
      warn(
        ctx,
        `advance ${job.slug}: DB error, retrying next tick: ${(e as Error).message}`,
      );
      continue;
    }
    if (scheduleErr) {
      if (!parked.has(job.id)) {
        parked.set(job.id, scheduleErr);
        warn(
          ctx,
          `advance ${job.slug}: ${scheduleErr} — parked until the file is edited`,
        );
      }
    }
    try {
      if (!job.file_path) {
        warn(ctx, `dispatch ${job.slug}: no file_path on ledger row — skipped`);
        continue;
      }
      // Tolerant parse: next_run_at should be ISO, but a hand-written
      // `YYYY-MM-DD HH:MM:SS` must not break trigger classification.
      const scheduledForMs = Date.parse(job.next_run_at);
      const overdueMs = Number.isFinite(scheduledForMs)
        ? now.getTime() - scheduledForMs
        : 0;
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
// spawned at most once (stale requests past RUN_REQUEST_EXPIRY_MS are stamped
// expired and never spawned). A spawn FAILURE releases the claim so the next
// tick retries; the runner links the invocation row back via
// CRONFISH_RUN_REQUEST_ID (it owns the invocation's creation).
function drainRunRequests(ctx: DaemonCtx, now: Date): void {
  for (const req of claimPendingRunRequests(ctx.db, now.toISOString())) {
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
      try {
        clearRunRequestClaim(ctx.db, req.id);
      } catch (e2) {
        warn(
          ctx,
          `run request #${req.id}: claim release failed: ${(e2 as Error).message}`,
        );
      }
    }
  }
}

// --- 4. In-daemon missed-run detection (the folded-in watchdog) ---
//
// Low-frequency phase (every MISSED_CHECK_EVERY_TICKS ticks): a job whose
// expected fire time is more than grace past due WHILE the daemon was live
// the whole window means something is wrong below the scheduler (runner
// failing to spawn, job never succeeding) → fire the existing missed-run
// alert path, deduped via cron_missed_alerts exactly like the standalone
// `cronfish watchdog`. Misses whose expected time predates this process's
// startedAt are downtime gaps — the catch-up dispatch owns those, no alert.
export const MISSED_CHECK_EVERY_TICKS = 60;

export async function checkMissedRuns(
  ctx: DaemonCtx,
  now: Date,
): Promise<WatchdogDecision[]> {
  const decisions = await runWatchdog({
    consumerRoot: ctx.consumerRoot,
    now,
    db: ctx.db,
    liveSince: new Date(ctx.startedAt),
  });
  for (const d of decisions) {
    if (d.outcome === "fired") {
      warn(ctx, `missed-run alert fired: ${d.slug} (expected ${d.expected_at})`);
    } else if (d.outcome === "fire-failed") {
      warn(
        ctx,
        `missed-run alert FAILED: ${d.slug}: ${d.error ?? "unknown"} (expected ${d.expected_at})`,
      );
    }
  }
  return decisions;
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
    drainRunRequests(ctx, now);
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

// --- Daemon mutual exclusion ---
//
// Two daemons on one consumer (a foreground debug run next to the launchd
// one) would BOTH dispatch every due job. Startup refuses when (a) the
// heartbeat row shows another live pid ticking recently, or (b) the exclusive
// lock file is held by a live pid. Same atomic O_EXCL + stale-takeover
// pattern as the runner's concurrency locks.

// A heartbeat this fresh from another pid proves a live daemon (1 Hz ticks
// make anything past 10s a wedge or a dead process). Mirrors cli.ts's
// DAEMON_FRESH_MS.
export const DAEMON_EXCLUSIVE_FRESH_MS = 10_000;

export function daemonLockPath(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "daemon.lock");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ExclusivityResult =
  | { ok: true }
  | { ok: false; reason: string };

export function acquireDaemonExclusivity(
  db: Database,
  consumerRoot: string,
  pid: number,
  now: Date = new Date(),
): ExclusivityResult {
  // 1. Heartbeat check — a fresh tick from another LIVE pid means a daemon
  // is already running (stale heartbeats and dead pids don't block).
  try {
    const hb = getDaemonHeartbeat(db);
    if (
      hb &&
      hb.pid !== pid &&
      now.getTime() - Date.parse(hb.last_tick_at) <= DAEMON_EXCLUSIVE_FRESH_MS &&
      isPidAlive(hb.pid)
    ) {
      return {
        ok: false,
        reason: `another daemon is live (pid ${hb.pid}, last tick ${hb.last_tick_at})`,
      };
    }
  } catch {
    // heartbeat table unreadable → fall through to the lock file
  }

  // 2. Exclusive lock file (atomic O_EXCL, stale-lock takeover if pid dead).
  const lockFile = daemonLockPath(consumerRoot);
  mkdirSync(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return { ok: true };
    } catch {
      let holder = Number.NaN;
      try {
        holder = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
      } catch {
        // lock vanished between open and read — retry the create
        continue;
      }
      if (!Number.isNaN(holder) && holder !== pid && isPidAlive(holder)) {
        return {
          ok: false,
          reason: `daemon lock ${lockFile} held by live pid ${holder}`,
        };
      }
      // Stale (dead pid / garbage) — take it over.
      try {
        rmSync(lockFile);
      } catch {}
    }
  }
  return { ok: false, reason: `could not acquire daemon lock ${lockFile}` };
}

export function releaseDaemonLock(consumerRoot: string, pid: number): void {
  const lockFile = daemonLockPath(consumerRoot);
  try {
    const holder = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
    if (holder === pid) rmSync(lockFile);
  } catch {}
}

// Foreground loop for `cronfish daemon`. SIGTERM/SIGINT stop the ticking and
// exit; in-flight children are independent runner processes and are left
// running (they hold their own locks and finish their own ledger rows).
export async function runDaemon(opts: { consumerRoot: string }): Promise<void> {
  const consumerRoot = opts.consumerRoot;
  const db = openDb(consumerRoot);
  const excl = acquireDaemonExclusivity(db, consumerRoot, process.pid);
  if (!excl.ok) {
    console.error(`[daemon] refusing to start: ${excl.reason}`);
    try {
      db.close();
    } catch {}
    process.exit(1);
  }
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
  let ticks = 0;
  // The missed-run check does network I/O (alert sends) — run it
  // fire-and-forget with a re-entrancy flag so a slow adapter can never
  // stall the tick loop (a stalled loop = stale heartbeat = `cron sync`
  // mistaking the daemon for dead).
  let missedCheckInFlight = false;
  while (running) {
    const t0 = Date.now();
    tickOnce(ctx, new Date());
    if (++ticks % MISSED_CHECK_EVERY_TICKS === 0 && !missedCheckInFlight) {
      missedCheckInFlight = true;
      checkMissedRuns(ctx, new Date())
        .catch((e) => {
          console.error(`[daemon] missed-run check: ${(e as Error).message}`);
        })
        .finally(() => {
          missedCheckInFlight = false;
        });
    }
    const elapsed = Date.now() - t0;
    if (elapsed > TICK_MS) {
      console.error(`[daemon] slow tick: ${elapsed}ms`);
    }
    await Bun.sleep(Math.max(0, TICK_MS - elapsed));
  }
  releaseDaemonLock(consumerRoot, process.pid);
  try {
    db.close();
  } catch {}
}
