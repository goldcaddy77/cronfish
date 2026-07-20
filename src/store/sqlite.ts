// SQLite implementation of the CronStore seam.
//
// Lives at <consumer-root>/.cronfish/db.sqlite via bun:sqlite (zero native dep).
// Every method is `async` (wrapping synchronous bun:sqlite calls in resolved
// promises) so the interface is uniform across backends. Migrations are a
// hand-rolled PRAGMA user_version step ladder — do NOT bring in Drizzle. The
// three multi-statement atomic operations (migrate, claimPendingRunRequests,
// pruneLedger) keep their transaction as a PRIVATE impl detail here; no generic
// `transaction(fn)` primitive is exposed.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JobMeta } from "../jobs.ts";
import { scheduleKind, type ScheduleKind } from "../next-run.ts";
import { RUNNING_PROTECT_MS } from "../prune.ts";
import { dbPath } from "./paths.ts";
import type {
  AlertLedgerStatus,
  CronStore,
  DaemonHeartbeatRow,
  DueJobRow,
  EnabledJobRow,
  InvocationResultRow,
  InvocationStatus,
  InvocationTrigger,
  InvocationWithDurationRow,
  InvocationWithSlugRow,
  JobRow,
  JobStatsRow,
  JobSyncStateRow,
  JobWithLastInvocationRow,
  LastResultRow,
  LedgerPruneOptions,
  LedgerPruneReport,
  RunHistoryRow,
  RunRequestRow,
  RunRequestStatusRow,
} from "./interface.ts";
import { RUN_REQUEST_EXPIRY_MS } from "./interface.ts";
import * as Q from "./sqlite-queries.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function scheduleAsText(schedule: JobMeta["schedule"]): string {
  if (schedule === undefined) return "manual";
  return String(schedule);
}

export class SqliteStore implements CronStore {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  // Documented test-only accessor — tests that seed/assert via raw SQL reach
  // the underlying handle through here rather than reconstructing it. Never
  // used by production code paths.
  rawHandleForTests(): Database {
    return this.#db;
  }

  // --- Lifecycle ---

  // `upTo` is test-only: builds a db as it existed at an older ladder rung so
  // migration tests can verify the fresh-db and upgraded-db paths converge.
  async migrate(upTo?: number): Promise<void> {
    const target = upTo ?? Q.MIGRATIONS.length;
    const current = (
      this.#db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    for (let v = current; v < target; v++) {
      const step = Q.MIGRATIONS[v]!;
      this.#db.transaction(() => {
        step(this.#db);
        this.#db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  // --- Jobs ---

  // `fileMtimeIso`/`fileSizeBytes` are the job file's stat, when the caller has
  // it (the daemon's change scan) — omitted, the stored values are left
  // untouched.
  async upsertJob(
    job: JobMeta,
    fileMtimeIso?: string,
    fileSizeBytes?: number,
  ): Promise<void> {
    // schedule_kind mirrors the schedule text; `manual` in scheduleAsText
    // covers the schedule-less case, so a parse failure just stores NULL.
    // One-time jobs (run_at, no schedule) are 'once' — a next_run_at with no
    // recurrence — NOT 'manual', or the daemon would never dispatch them.
    let kind: ScheduleKind | null = null;
    if (job.oneTime) {
      kind = "once";
    } else {
      try {
        kind = scheduleKind(scheduleAsText(job.schedule));
      } catch {}
    }
    this.#db.prepare(Q.SQLITE_UPSERT_JOB).run({
      $slug: job.slug,
      $kind: job.kind,
      $schedule: scheduleAsText(job.schedule),
      $enabled: job.enabled ? 1 : 0,
      $timeout_s: job.timeout ?? null,
      $retries: job.retries ?? 0,
      $concurrency: job.concurrency ?? "skip",
      $model: job.model ?? null,
      $description: job.description ?? null,
      $now: nowIso(),
      $state: job.enabled ? "active" : "disabled",
      $schedule_kind: kind,
      $file_path: job.path,
      $file_mtime: fileMtimeIso ?? null,
      $file_size: fileSizeBytes ?? null,
    });
  }

  async markDeleted(slugsPresent: string[]): Promise<void> {
    const now = nowIso();
    if (slugsPresent.length === 0) {
      this.#db.prepare(Q.SQLITE_MARK_DELETED_ALL).run({ $now: now });
      return;
    }
    const params: Record<string, string> = { $now: now };
    slugsPresent.forEach((s, i) => (params[`$s${i}`] = s));
    this.#db
      .prepare(Q.buildSqliteMarkDeletedExcept(slugsPresent.length))
      .run(params);
  }

  async getJobIdBySlug(slug: string): Promise<number | null> {
    const row = this.#db.query(Q.SQLITE_JOB_ID_BY_SLUG).get({ $slug: slug }) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  async listEnabledJobs(): Promise<EnabledJobRow[]> {
    return this.#db.query(Q.SQLITE_LIST_ENABLED_JOBS).all() as EnabledJobRow[];
  }

  async listDueJobs(nowIsoStr: string): Promise<DueJobRow[]> {
    return this.#db
      .query(Q.SQLITE_LIST_DUE_JOBS)
      .all({ $now: nowIsoStr }) as DueJobRow[];
  }

  async listJobSyncState(): Promise<JobSyncStateRow[]> {
    return this.#db
      .query(Q.SQLITE_LIST_JOB_SYNC_STATE)
      .all() as JobSyncStateRow[];
  }

  async setJobNextRun(
    jobId: number,
    nextRunAtIso: string | null,
  ): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_SET_JOB_NEXT_RUN)
      .run({ $id: jobId, $next: nextRunAtIso });
  }

  async setJobLastRun(
    jobId: number,
    lastRunAtIso: string,
    lastStatus: InvocationStatus,
  ): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_SET_JOB_LAST_RUN)
      .run({ $id: jobId, $last: lastRunAtIso, $status: lastStatus });
  }

  // --- Invocations ---

  async startInvocation(
    jobId: number,
    trigger: InvocationTrigger,
    logPath: string,
    opts?: { attempt?: number; scheduledFor?: string },
  ): Promise<number> {
    const res = this.#db.prepare(Q.SQLITE_START_INVOCATION).run({
      $job_id: jobId,
      $now: nowIso(),
      $trigger: trigger,
      $log_path: logPath,
      $attempt: opts?.attempt ?? 1,
      $scheduled_for: opts?.scheduledFor ?? null,
    });
    return Number(res.lastInsertRowid);
  }

  async finishInvocation(
    invocationId: number,
    status: InvocationStatus,
    exitCode: number | null,
    result?: InvocationResultRow,
    attempt?: number,
  ): Promise<void> {
    // duration_ms is materialized at finish time so reporting never does TEXT
    // date math at query time.
    const now = nowIso();
    const startedRow = this.#db
      .query(Q.SQLITE_INVOCATION_STARTED_AT)
      .get({ $id: invocationId }) as { started_at: string } | undefined;
    const durationMs = startedRow
      ? Math.max(0, Date.parse(now) - Date.parse(startedRow.started_at))
      : null;
    this.#db.prepare(Q.SQLITE_FINISH_INVOCATION).run({
      $id: invocationId,
      $now: now,
      $duration_ms: durationMs,
      $attempt: attempt ?? null,
      $status: status,
      $exit_code: exitCode,
      $result_summary: result?.summary ?? null,
      $result_ok:
        result?.ok === undefined || result?.ok === null
          ? null
          : result.ok
            ? 1
            : 0,
      $result_json: result?.json ?? null,
      $result_truncated: result?.truncated ? 1 : 0,
    });
  }

  async setInvocationAlert(
    invocationId: number,
    status: AlertLedgerStatus,
    error: string | null,
  ): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_SET_INVOCATION_ALERT)
      .run({ $id: invocationId, $status: status, $error: error });
  }

  async setInvocationLogPath(
    invocationId: number,
    logPath: string,
  ): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_SET_INVOCATION_LOG_PATH)
      .run({ $p: logPath, $id: invocationId });
  }

  async getInvocationLogPath(invocationId: number): Promise<string | null> {
    const row = this.#db
      .query(Q.SQLITE_GET_INVOCATION_LOG_PATH)
      .get({ $id: invocationId }) as { log_path: string } | undefined;
    return row?.log_path ?? null;
  }

  async getLastOkStartedAt(jobId: number): Promise<string | null> {
    const row = this.#db
      .query(Q.SQLITE_LAST_OK_STARTED_AT)
      .get({ $job_id: jobId }) as { started_at: string } | undefined;
    return row?.started_at ?? null;
  }

  // Most recent finished invocation for a job (excluding the given id).
  // Used by the runner to decide whether the current ok run is a recovery.
  async getPreviousFinishedStatus(
    jobId: number,
    excludingId: number,
  ): Promise<InvocationStatus | null> {
    const row = this.#db
      .query(Q.SQLITE_PREVIOUS_FINISHED_STATUS)
      .get({ $job_id: jobId, $id: excludingId }) as
      | { status: InvocationStatus }
      | undefined;
    return row?.status ?? null;
  }

  // --- Missed-run alerts ---

  async getLatestMissedFiredAt(jobId: number): Promise<string | null> {
    const row = this.#db
      .query(Q.SQLITE_LATEST_MISSED_FIRED_AT)
      .get({ $job_id: jobId }) as { fired_at: string } | undefined;
    return row?.fired_at ?? null;
  }

  async recordMissedAlert(
    jobId: number,
    expectedAtIso: string,
  ): Promise<number> {
    const res = this.#db.prepare(Q.SQLITE_RECORD_MISSED_ALERT).run({
      $job_id: jobId,
      $expected_at: expectedAtIso,
      $now: nowIso(),
    });
    return Number(res.lastInsertRowid);
  }

  // --- Run requests ---

  // `cron run <slug>` inserts one; the daemon drains them next tick.
  async insertRunRequest(jobId: number): Promise<number> {
    const res = this.#db
      .prepare(Q.SQLITE_INSERT_RUN_REQUEST)
      .run({ $job_id: jobId, $now: nowIso() });
    return Number(res.lastInsertRowid);
  }

  // Claim every pending request atomically: mark picked_up_at, return the
  // claimed rows. A second drain in the same tick (or a racing process) gets
  // nothing — picked_up_at is the claim. Requests older than
  // RUN_REQUEST_EXPIRY_MS are stamped expired_at and never spawned. The
  // expire-stale → select claimable → per-row claim ordering is the atomic CAS
  // core; the whole thing runs inside one bun:sqlite transaction.
  async claimPendingRunRequests(nowIsoStr?: string): Promise<RunRequestRow[]> {
    const now = nowIsoStr ?? nowIso();
    return this.#db.transaction(() => {
      const cutoff = new Date(
        Date.parse(now) - RUN_REQUEST_EXPIRY_MS,
      ).toISOString();
      this.#db
        .prepare(Q.SQLITE_EXPIRE_STALE_RUN_REQUESTS)
        .run({ $now: now, $cutoff: cutoff });
      const rows = this.#db
        .query(Q.SQLITE_SELECT_CLAIMABLE_RUN_REQUESTS)
        .all() as RunRequestRow[];
      const claim = this.#db.prepare(Q.SQLITE_CLAIM_RUN_REQUEST);
      for (const r of rows) claim.run({ $id: r.id, $now: now });
      return rows;
    })();
  }

  async expireRunRequest(requestId: number): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_EXPIRE_RUN_REQUEST)
      .run({ $id: requestId, $now: nowIso() });
  }

  async clearRunRequestClaim(requestId: number): Promise<void> {
    this.#db.prepare(Q.SQLITE_CLEAR_RUN_REQUEST_CLAIM).run({ $id: requestId });
  }

  async linkRunRequestInvocation(
    requestId: number,
    invocationId: number,
  ): Promise<void> {
    this.#db
      .prepare(Q.SQLITE_LINK_RUN_REQUEST_INVOCATION)
      .run({ $id: requestId, $inv: invocationId });
  }

  async getRunRequest(requestId: number): Promise<RunRequestStatusRow | null> {
    const row = this.#db
      .query(Q.SQLITE_GET_RUN_REQUEST)
      .get({ $id: requestId }) as RunRequestStatusRow | undefined;
    return row ?? null;
  }

  // --- Heartbeat ---

  // Upserted every tick. A restart (new pid/started_at) resets tick_count;
  // the same process just bumps it and refreshes last_tick_at.
  async beatDaemonHeartbeat(opts: {
    pid: number;
    startedAt: string;
    version?: string;
  }): Promise<void> {
    this.#db.prepare(Q.SQLITE_BEAT_HEARTBEAT).run({
      $pid: opts.pid,
      $started_at: opts.startedAt,
      $now: nowIso(),
      $version: opts.version ?? null,
    });
  }

  async getDaemonHeartbeat(): Promise<DaemonHeartbeatRow | null> {
    const row = this.#db.query(Q.SQLITE_GET_HEARTBEAT).get() as
      | DaemonHeartbeatRow
      | undefined;
    return row ?? null;
  }

  // --- Reporting ---

  async listRunHistory(
    opts: { slug?: string; limit?: number; sinceIso?: string } = {},
  ): Promise<RunHistoryRow[]> {
    return this.#db.query(Q.SQLITE_LIST_RUN_HISTORY).all({
      $slug: opts.slug ?? null,
      $since: opts.sinceIso ?? null,
      $limit: opts.limit ?? 50,
    }) as RunHistoryRow[];
  }

  // Per-job health rollup over a window. Aggregates run in SQL over duration_ms;
  // p95 is nearest-rank over the sorted durations, computed here in JS because
  // SQLite has no percentile function (dialect-neutral math kept in the impl).
  async jobStats(opts: { sinceIso?: string } = {}): Promise<JobStatsRow[]> {
    const since = opts.sinceIso ?? null;
    const rows = this.#db.query(Q.SQLITE_JOB_STATS).all({ $since: since }) as (Omit<
      JobStatsRow,
      "success_rate" | "p95_duration_ms"
    > & { finished: number })[];

    const durations = this.#db
      .query(Q.SQLITE_JOB_STATS_DURATIONS)
      .all({ $since: since }) as { slug: string; duration_ms: number }[];
    const bySlug = new Map<string, number[]>();
    for (const d of durations) {
      let list = bySlug.get(d.slug);
      if (!list) bySlug.set(d.slug, (list = []));
      list.push(d.duration_ms);
    }

    return rows.map(({ finished, ...row }) => {
      const sorted = bySlug.get(row.slug) ?? [];
      const p95 =
        sorted.length === 0
          ? null
          : sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
      return {
        ...row,
        success_rate: finished > 0 ? row.ok / finished : null,
        p95_duration_ms: p95 ?? null,
      };
    });
  }

  // --- UI / CLI read views ---

  async listJobsWithLastInvocation(): Promise<JobWithLastInvocationRow[]> {
    return this.#db
      .query(Q.SQLITE_LIST_JOBS_WITH_LAST_INVOCATION)
      .all() as JobWithLastInvocationRow[];
  }

  async getJobBySlug(slug: string): Promise<JobRow | null> {
    const row = this.#db.query(Q.SQLITE_GET_JOB_BY_SLUG).get(slug) as
      | JobRow
      | undefined;
    return row ?? null;
  }

  async getLastInvocationStartedAt(slug: string): Promise<string | null> {
    const row = this.#db
      .query(Q.SQLITE_LAST_INVOCATION_STARTED_AT)
      .get(slug) as { started_at: string | null } | undefined;
    return row?.started_at ?? null;
  }

  async listInvocationsForSlug(
    slug: string,
    limit: number,
  ): Promise<InvocationWithDurationRow[]> {
    return this.#db
      .query(Q.SQLITE_LIST_INVOCATIONS_FOR_SLUG)
      .all(slug, limit) as InvocationWithDurationRow[];
  }

  async listAllInvocations(limit: number): Promise<InvocationWithSlugRow[]> {
    return this.#db
      .query(Q.SQLITE_LIST_ALL_INVOCATIONS)
      .all(limit) as InvocationWithSlugRow[];
  }

  async getInvocationWithDuration(
    id: number,
  ): Promise<InvocationWithSlugRow | null> {
    const row = this.#db.query(Q.SQLITE_GET_INVOCATION_WITH_DURATION).get(id) as
      | InvocationWithSlugRow
      | undefined;
    return row ?? null;
  }

  async getLastResults(): Promise<LastResultRow[]> {
    return this.#db.query(Q.SQLITE_LAST_RESULTS).all() as LastResultRow[];
  }

  // --- Ledger prune (multi-DELETE transaction is a private impl detail) ---

  async pruneLedger(opts: LedgerPruneOptions): Promise<LedgerPruneReport> {
    const nowMs = opts.nowMs ?? Date.now();
    const runningCutoff = new Date(nowMs - RUNNING_PROTECT_MS).toISOString();
    const report: LedgerPruneReport = {
      invocations: 0,
      runRequests: 0,
      missedAlerts: 0,
    };

    const jobs = this.#db.query(Q.SQLITE_PRUNE_LIST_JOBS).all() as {
      id: number;
      slug: string;
    }[];

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
          const count = (
            sql: string,
            params: Record<string, unknown>,
          ): number => (this.#db.query(sql).get(params) as { n: number }).n;
          report.missedAlerts += count(Q.SQLITE_PRUNE_COUNT_MISSED, p);
          report.runRequests += count(Q.SQLITE_PRUNE_COUNT_RUN_REQUESTS, p);
          report.invocations += count(Q.SQLITE_PRUNE_COUNT_INVOCATIONS, {
            ...p,
            $running_cutoff: runningCutoff,
          });
          continue;
        }

        report.missedAlerts += this.#db
          .prepare(Q.SQLITE_PRUNE_DELETE_MISSED)
          .run(p).changes;
        report.runRequests += this.#db
          .prepare(Q.SQLITE_PRUNE_DELETE_RUN_REQUESTS)
          .run(p).changes;
        // A surviving run request may still reference a doomed invocation
        // (foreign_keys=ON would abort the delete) — sever the link first.
        const pInv = { ...p, $running_cutoff: runningCutoff };
        this.#db.prepare(Q.SQLITE_PRUNE_NULL_RUN_REQUEST_REFS).run(pInv);
        report.invocations += this.#db
          .prepare(Q.SQLITE_PRUNE_DELETE_INVOCATIONS)
          .run(pInv).changes;
      }
    };

    if (opts.dryRun) work();
    else this.#db.transaction(work)();
    return report;
  }
}

// Open (creating if needed) the consumer's ledger db, apply PRAGMAs in the
// exact db.ts order, run migrations, and return a ready SqliteStore. This is
// the SQLite-specific opener; store-agnostic dispatch (sqlite vs postgres) lives
// in open.ts, which re-exports the public `openStore`/`tryOpenStore` names.
export async function openSqliteStore(
  consumerRoot: string,
): Promise<SqliteStore> {
  const path = dbPath(consumerRoot);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // The daemon, runner children, and CLI verbs all hit this file concurrently.
  // Without a busy timeout a writer collision surfaces as an instant
  // SQLITE_BUSY error; 5s of retry absorbs normal contention.
  db.exec("PRAGMA busy_timeout = 5000");
  const store = new SqliteStore(db);
  await store.migrate();
  return store;
}

// Fail-soft SQLite open for read paths (CLI status/heartbeat peeks): returns
// null on a missing file or any open failure instead of creating .cronfish/ or
// throwing. A `readonly` handle never migrates — callers tolerate a pre-v6
// schema. Exactly today's behavior, preserved for the sqlite dispatch branch.
export async function tryOpenSqliteStore(
  consumerRoot: string,
  opts: { readonly?: boolean } = {},
): Promise<CronStore | null> {
  const path = dbPath(consumerRoot);
  try {
    if (opts.readonly) {
      const db = new Database(path, { readonly: true });
      return new SqliteStore(db);
    }
    return await openSqliteStore(consumerRoot);
  } catch {
    return null;
  }
}
