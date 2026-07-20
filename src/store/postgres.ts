// Postgres implementation of the CronStore seam.
//
// Backed by Bun's built-in `Bun.sql` (Bun ≥ 1.3) — ZERO new npm dependency, the
// same posture as bun:sqlite for the default backend. Every table lives in a
// configured schema; the migration ladder is a `<schema>.cron_migrations`
// version table (Postgres has no PRAGMA user_version). A Postgres store is
// always FRESH, so migration #1 creates the final v6-equivalent schema directly
// rather than replaying the SQLite v1→v6 evolution.
//
// SHAPE PARITY is the contract: Bun.sql returns every BIGINT column (identity
// ids, COUNT/duration aggregates) as a STRING, and AVG as a numeric string, so
// each read normalizes those back to JS `number` to match SqliteStore row for
// row. The three multi-statement atomic ops (migrate, claimPendingRunRequests,
// pruneLedger) run inside `sql.begin(...)` transactions — the transaction is a
// private impl detail, never a leaked `transaction(fn)` primitive.

import type { JobMeta } from "../jobs.ts";
import { scheduleKind, type ScheduleKind } from "../next-run.ts";
import { RUNNING_PROTECT_MS } from "../prune.ts";
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
import { buildPostgresQueries, type PgQuery } from "./postgres-queries.ts";

// Minimal structural type for the Bun.sql handle we use — a tagged-template
// callable that also carries `unsafe`, `begin`, and `end`. Typed here (rather
// than importing Bun's `SQL`) so the module compiles even where the ambient Bun
// types lag; the runtime object is the real thing.
interface BunSqlTx {
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
}
interface BunSql extends BunSqlTx {
  begin<T>(fn: (tx: BunSqlTx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<
    Record<string, unknown>[]
  >;
}

function nowIso(): string {
  return new Date().toISOString();
}

function scheduleAsText(schedule: JobMeta["schedule"]): string {
  if (schedule === undefined) return "manual";
  return String(schedule);
}

// Bun.sql returns BIGINT (and COUNT/AVG aggregates) as strings; coerce to a JS
// number, preserving null. This is the row-shape bridge to SqliteStore.
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return Number(v);
}

// A required numeric column (never null in a well-formed row).
function reqNum(v: unknown): number {
  return num(v) as number;
}

export class PostgresStore implements CronStore {
  #sql: BunSql;
  #q: ReturnType<typeof buildPostgresQueries>;

  private constructor(sql: BunSql, schema: string) {
    this.#sql = sql;
    this.#q = buildPostgresQueries(schema);
  }

  // Connect and migrate. `schema` is validated as an identifier inside
  // buildPostgresQueries, so an injection attempt throws here, before any DDL.
  static async open(opts: {
    url: string;
    schema: string;
  }): Promise<PostgresStore> {
    const SQL = (Bun as unknown as { SQL: new (url: string) => BunSql }).SQL;
    const sql = new SQL(opts.url);
    const store = new PostgresStore(sql, opts.schema);
    await store.migrate();
    return store;
  }

  private async run(q: PgQuery): Promise<Record<string, unknown>[]> {
    return this.#sql.unsafe(q.text, q.values);
  }

  // --- Lifecycle ---

  // Ladder: read the max applied version, apply each missing step inside its
  // own transaction, stamp cron_migrations. `upTo` mirrors SqliteStore.migrate
  // for symmetry; the Postgres ladder currently has one step (the v6-equivalent
  // end state), so `upTo` only ever caps at 1.
  async migrate(upTo?: number): Promise<void> {
    // Schema + bookkeeping table must exist before we can read the version.
    await this.#sql.unsafe(this.#q.createSchema);
    await this.#sql.unsafe(this.#q.createMigrationsTable);

    const steps: Array<(tx: BunSqlTx) => Promise<void>> = [
      // v1 (Postgres) — the final v6-equivalent schema, created directly.
      async (tx) => {
        for (const ddl of this.#q.createFinalSchema) {
          await tx.unsafe(ddl);
        }
      },
    ];

    const target = Math.min(upTo ?? steps.length, steps.length);
    const cur = reqNum(
      (await this.#sql.unsafe(this.#q.maxMigrationVersion))[0]!.version,
    );
    for (let v = cur; v < target; v++) {
      const step = steps[v]!;
      await this.#sql.begin(async (tx) => {
        await step(tx);
        const rec = this.#q.recordMigration(v + 1, nowIso());
        await tx.unsafe(rec.text, rec.values);
      });
    }
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }

  // --- Jobs ---

  async upsertJob(
    job: JobMeta,
    fileMtimeIso?: string,
    fileSizeBytes?: number,
  ): Promise<void> {
    let kind: ScheduleKind | null = null;
    if (job.oneTime) {
      kind = "once";
    } else {
      try {
        kind = scheduleKind(scheduleAsText(job.schedule));
      } catch {}
    }
    await this.run(
      this.#q.upsertJob({
        slug: job.slug,
        kind: job.kind,
        schedule: scheduleAsText(job.schedule),
        enabled: job.enabled ? 1 : 0,
        timeout_s: job.timeout ?? null,
        retries: job.retries ?? 0,
        concurrency: job.concurrency ?? "skip",
        model: job.model ?? null,
        description: job.description ?? null,
        now: nowIso(),
        state: job.enabled ? "active" : "disabled",
        schedule_kind: kind,
        file_path: job.path,
        file_mtime: fileMtimeIso ?? null,
        file_size: fileSizeBytes ?? null,
      }),
    );
  }

  async markDeleted(slugsPresent: string[]): Promise<void> {
    const now = nowIso();
    if (slugsPresent.length === 0) {
      await this.run(this.#q.markDeletedAll(now));
      return;
    }
    await this.run(this.#q.markDeletedExcept(now, slugsPresent));
  }

  async getJobIdBySlug(slug: string): Promise<number | null> {
    const rows = await this.run(this.#q.jobIdBySlug(slug));
    return rows[0] ? reqNum(rows[0].id) : null;
  }

  async listEnabledJobs(): Promise<EnabledJobRow[]> {
    const rows = await this.run(this.#q.listEnabledJobs());
    return rows.map((r) => ({
      id: reqNum(r.id),
      slug: r.slug as string,
      schedule: r.schedule as string,
    }));
  }

  async listDueJobs(nowIsoStr: string): Promise<DueJobRow[]> {
    const rows = await this.run(this.#q.listDueJobs(nowIsoStr));
    return rows.map((r) => ({
      id: reqNum(r.id),
      slug: r.slug as string,
      kind: r.kind as string,
      schedule: r.schedule as string,
      schedule_kind: r.schedule_kind as DueJobRow["schedule_kind"],
      next_run_at: r.next_run_at as string,
      last_run_at: (r.last_run_at as string | null) ?? null,
      concurrency: r.concurrency as string,
      retries: reqNum(r.retries),
      timeout_s: num(r.timeout_s),
      file_path: (r.file_path as string | null) ?? null,
    }));
  }

  async listJobSyncState(): Promise<JobSyncStateRow[]> {
    const rows = await this.run(this.#q.listJobSyncState());
    return rows.map((r) => ({
      id: reqNum(r.id),
      slug: r.slug as string,
      state: r.state as JobSyncStateRow["state"],
      schedule: r.schedule as string,
      schedule_kind: r.schedule_kind as JobSyncStateRow["schedule_kind"],
      file_mtime: (r.file_mtime as string | null) ?? null,
      file_size: num(r.file_size),
      next_run_at: (r.next_run_at as string | null) ?? null,
      last_run_at: (r.last_run_at as string | null) ?? null,
    }));
  }

  async setJobNextRun(
    jobId: number,
    nextRunAtIso: string | null,
  ): Promise<void> {
    await this.run(this.#q.setJobNextRun(jobId, nextRunAtIso));
  }

  async setJobLastRun(
    jobId: number,
    lastRunAtIso: string,
    lastStatus: InvocationStatus,
  ): Promise<void> {
    await this.run(this.#q.setJobLastRun(jobId, lastRunAtIso, lastStatus));
  }

  // --- Invocations ---

  async startInvocation(
    jobId: number,
    trigger: InvocationTrigger,
    logPath: string,
    opts?: { attempt?: number; scheduledFor?: string },
  ): Promise<number> {
    const rows = await this.run(
      this.#q.startInvocation({
        job_id: jobId,
        now: nowIso(),
        trigger,
        log_path: logPath,
        attempt: opts?.attempt ?? 1,
        scheduled_for: opts?.scheduledFor ?? null,
      }),
    );
    return reqNum(rows[0]!.id);
  }

  async finishInvocation(
    invocationId: number,
    status: InvocationStatus,
    exitCode: number | null,
    result?: InvocationResultRow,
    attempt?: number,
  ): Promise<void> {
    const now = nowIso();
    const startedRows = await this.run(
      this.#q.invocationStartedAt(invocationId),
    );
    const startedAt = startedRows[0]?.started_at as string | undefined;
    const durationMs = startedAt
      ? Math.max(0, Date.parse(now) - Date.parse(startedAt))
      : null;
    await this.run(
      this.#q.finishInvocation({
        id: invocationId,
        now,
        status,
        exit_code: exitCode,
        duration_ms: durationMs,
        attempt: attempt ?? null,
        result_summary: result?.summary ?? null,
        result_ok:
          result?.ok === undefined || result?.ok === null
            ? null
            : result.ok
              ? 1
              : 0,
        result_json: result?.json ?? null,
        result_truncated: result?.truncated ? 1 : 0,
      }),
    );
  }

  async setInvocationAlert(
    invocationId: number,
    status: AlertLedgerStatus,
    error: string | null,
  ): Promise<void> {
    await this.run(this.#q.setInvocationAlert(invocationId, status, error));
  }

  async setInvocationLogPath(
    invocationId: number,
    logPath: string,
  ): Promise<void> {
    await this.run(this.#q.setInvocationLogPath(invocationId, logPath));
  }

  async getInvocationLogPath(invocationId: number): Promise<string | null> {
    const rows = await this.run(this.#q.getInvocationLogPath(invocationId));
    return (rows[0]?.log_path as string | undefined) ?? null;
  }

  async getLastOkStartedAt(jobId: number): Promise<string | null> {
    const rows = await this.run(this.#q.lastOkStartedAt(jobId));
    return (rows[0]?.started_at as string | undefined) ?? null;
  }

  async getPreviousFinishedStatus(
    jobId: number,
    excludingId: number,
  ): Promise<InvocationStatus | null> {
    const rows = await this.run(
      this.#q.previousFinishedStatus(jobId, excludingId),
    );
    return (rows[0]?.status as InvocationStatus | undefined) ?? null;
  }

  // --- Missed-run alerts ---

  async getLatestMissedFiredAt(jobId: number): Promise<string | null> {
    const rows = await this.run(this.#q.latestMissedFiredAt(jobId));
    return (rows[0]?.fired_at as string | undefined) ?? null;
  }

  async recordMissedAlert(
    jobId: number,
    expectedAtIso: string,
  ): Promise<number> {
    const rows = await this.run(
      this.#q.recordMissedAlert(jobId, expectedAtIso, nowIso()),
    );
    return reqNum(rows[0]!.id);
  }

  // --- Run requests ---

  async insertRunRequest(jobId: number): Promise<number> {
    const rows = await this.run(this.#q.insertRunRequest(jobId, nowIso()));
    return reqNum(rows[0]!.id);
  }

  // Claim every pending request atomically. Inside one transaction: expire
  // stale requests, then a single-statement CAS `UPDATE ... RETURNING` claims
  // all currently-pending rows (row-locking them so concurrent callers get
  // disjoint sets) joined to their job for slug/file_path. Match RunRequestRow
  // shape (id/job_id coerced from BIGINT strings).
  async claimPendingRunRequests(nowIsoStr?: string): Promise<RunRequestRow[]> {
    const now = nowIsoStr ?? nowIso();
    const cutoff = new Date(
      Date.parse(now) - RUN_REQUEST_EXPIRY_MS,
    ).toISOString();
    const claimed = await this.#sql.begin(async (tx) => {
      const expire = this.#q.expireStaleRunRequests(now, cutoff);
      await tx.unsafe(expire.text, expire.values);
      const claim = this.#q.claimRunRequests(now);
      return tx.unsafe(claim.text, claim.values);
    });
    // The single-statement claim returns rows unordered; the SQLite path yields
    // them requested_at/id ascending. Sort here so the contract matches.
    return claimed
      .map((r) => ({
        id: reqNum(r.id),
        job_id: reqNum(r.job_id),
        slug: r.slug as string,
        trigger: "manual" as const,
        requested_at: r.requested_at as string,
        file_path: (r.file_path as string | null) ?? null,
      }))
      .sort((a, b) =>
        a.requested_at < b.requested_at
          ? -1
          : a.requested_at > b.requested_at
            ? 1
            : a.id - b.id,
      );
  }

  async expireRunRequest(requestId: number): Promise<void> {
    await this.run(this.#q.expireRunRequest(requestId, nowIso()));
  }

  async clearRunRequestClaim(requestId: number): Promise<void> {
    await this.run(this.#q.clearRunRequestClaim(requestId));
  }

  async linkRunRequestInvocation(
    requestId: number,
    invocationId: number,
  ): Promise<void> {
    await this.run(
      this.#q.linkRunRequestInvocation(requestId, invocationId),
    );
  }

  async getRunRequest(requestId: number): Promise<RunRequestStatusRow | null> {
    const rows = await this.run(this.#q.getRunRequest(requestId));
    const r = rows[0];
    if (!r) return null;
    return {
      picked_up_at: (r.picked_up_at as string | null) ?? null,
      invocation_id: num(r.invocation_id),
      expired_at: (r.expired_at as string | null) ?? null,
    };
  }

  // --- Heartbeat ---

  async beatDaemonHeartbeat(opts: {
    pid: number;
    startedAt: string;
    version?: string;
  }): Promise<void> {
    await this.run(
      this.#q.beatHeartbeat({
        pid: opts.pid,
        started_at: opts.startedAt,
        now: nowIso(),
        version: opts.version ?? null,
      }),
    );
  }

  async getDaemonHeartbeat(): Promise<DaemonHeartbeatRow | null> {
    const rows = await this.run(this.#q.getHeartbeat());
    const r = rows[0];
    if (!r) return null;
    return {
      pid: reqNum(r.pid),
      started_at: r.started_at as string,
      last_tick_at: r.last_tick_at as string,
      version: (r.version as string | null) ?? null,
      tick_count: reqNum(r.tick_count),
    };
  }

  // --- Reporting ---

  async listRunHistory(
    opts: { slug?: string; limit?: number; sinceIso?: string } = {},
  ): Promise<RunHistoryRow[]> {
    const rows = await this.run(
      this.#q.listRunHistory(
        opts.slug ?? null,
        opts.sinceIso ?? null,
        opts.limit ?? 50,
      ),
    );
    return rows.map((r) => ({
      id: reqNum(r.id),
      slug: r.slug as string,
      started_at: r.started_at as string,
      finished_at: (r.finished_at as string | null) ?? null,
      status: r.status as InvocationStatus,
      trigger: r.trigger as InvocationTrigger,
      attempt: reqNum(r.attempt),
      duration_ms: num(r.duration_ms),
      scheduled_for: (r.scheduled_for as string | null) ?? null,
      exit_code: num(r.exit_code),
      result_summary: (r.result_summary as string | null) ?? null,
      log_path: r.log_path as string,
    }));
  }

  async jobStats(opts: { sinceIso?: string } = {}): Promise<JobStatsRow[]> {
    const since = opts.sinceIso ?? null;
    const rows = await this.run(this.#q.jobStats(since));
    const durationRows = await this.run(this.#q.jobStatsDurations(since));

    const bySlug = new Map<string, number[]>();
    for (const d of durationRows) {
      const slug = d.slug as string;
      let list = bySlug.get(slug);
      if (!list) bySlug.set(slug, (list = []));
      list.push(reqNum(d.duration_ms));
    }

    return rows.map((r) => {
      const slug = r.slug as string;
      const ok = reqNum(r.ok);
      const finished = reqNum(r.finished);
      const sorted = bySlug.get(slug) ?? [];
      const p95 =
        sorted.length === 0
          ? null
          : sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
      return {
        slug,
        runs: reqNum(r.runs),
        ok,
        fail: reqNum(r.fail),
        timeout: reqNum(r.timeout),
        success_rate: finished > 0 ? ok / finished : null,
        avg_duration_ms: num(r.avg_duration_ms),
        p95_duration_ms: p95 ?? null,
        last_run_at: (r.last_run_at as string | null) ?? null,
        last_status: (r.last_status as string | null) ?? null,
      };
    });
  }

  // --- UI / CLI read views ---

  async listJobsWithLastInvocation(): Promise<JobWithLastInvocationRow[]> {
    const rows = await this.run(this.#q.listJobsWithLastInvocation());
    return rows.map((r) => this.#mapJobWithLastInvocation(r));
  }

  #mapJobRow(r: Record<string, unknown>): JobRow {
    return {
      id: reqNum(r.id),
      slug: r.slug as string,
      kind: r.kind as string,
      schedule: r.schedule as string,
      enabled: reqNum(r.enabled),
      timeout_s: num(r.timeout_s),
      retries: reqNum(r.retries),
      concurrency: r.concurrency as string,
      model: (r.model as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      last_synced_at: r.last_synced_at as string,
      deleted_at: (r.deleted_at as string | null) ?? null,
      state: (r.state as string | null) ?? null,
      schedule_kind: (r.schedule_kind as string | null) ?? null,
      next_run_at: (r.next_run_at as string | null) ?? null,
    };
  }

  #mapJobWithLastInvocation(
    r: Record<string, unknown>,
  ): JobWithLastInvocationRow {
    return {
      ...this.#mapJobRow(r),
      last_status: (r.last_status as string | null) ?? null,
      last_started_at: (r.last_started_at as string | null) ?? null,
      last_finished_at: (r.last_finished_at as string | null) ?? null,
      last_exit_code: num(r.last_exit_code),
      last_duration_ms: num(r.last_duration_ms),
      last_invocation_id: num(r.last_invocation_id),
    };
  }

  async getJobBySlug(slug: string): Promise<JobRow | null> {
    const rows = await this.run(this.#q.getJobBySlug(slug));
    return rows[0] ? this.#mapJobRow(rows[0]) : null;
  }

  async getLastInvocationStartedAt(slug: string): Promise<string | null> {
    const rows = await this.run(this.#q.lastInvocationStartedAt(slug));
    return (rows[0]?.started_at as string | null | undefined) ?? null;
  }

  #mapInvocationWithSlug(r: Record<string, unknown>): InvocationWithSlugRow {
    return {
      id: reqNum(r.id),
      job_id: reqNum(r.job_id),
      started_at: r.started_at as string,
      finished_at: (r.finished_at as string | null) ?? null,
      status: r.status as string,
      exit_code: num(r.exit_code),
      trigger: r.trigger as string,
      log_path: r.log_path as string,
      result_summary: (r.result_summary as string | null) ?? null,
      result_ok: num(r.result_ok),
      result_json: (r.result_json as string | null) ?? null,
      result_truncated: reqNum(r.result_truncated),
      slug: r.slug as string,
      duration_ms: num(r.duration_ms),
    };
  }

  async listInvocationsForSlug(
    slug: string,
    limit: number,
  ): Promise<InvocationWithDurationRow[]> {
    const rows = await this.run(this.#q.listInvocationsForSlug(slug, limit));
    // InvocationWithDurationRow has no `slug` field, but the extra key is
    // harmless and the SQLite query also omits it — mirror by dropping slug.
    return rows.map((r) => {
      const { slug: _slug, ...rest } = this.#mapInvocationWithSlug({
        ...r,
        slug: "",
      });
      return rest;
    });
  }

  async listAllInvocations(limit: number): Promise<InvocationWithSlugRow[]> {
    const rows = await this.run(this.#q.listAllInvocations(limit));
    return rows.map((r) => this.#mapInvocationWithSlug(r));
  }

  async getInvocationWithDuration(
    id: number,
  ): Promise<InvocationWithSlugRow | null> {
    const rows = await this.run(this.#q.getInvocationWithDuration(id));
    return rows[0] ? this.#mapInvocationWithSlug(rows[0]) : null;
  }

  async getLastResults(): Promise<LastResultRow[]> {
    const rows = await this.run(this.#q.lastResults());
    return rows.map((r) => ({
      slug: r.slug as string,
      result_summary: (r.result_summary as string | null) ?? null,
      finished_at: (r.finished_at as string | null) ?? null,
    }));
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

    const jobRows = await this.run(this.#q.pruneListJobs());
    const jobs = jobRows.map((r) => ({
      id: reqNum(r.id),
      slug: r.slug as string,
    }));

    const plan = jobs
      .filter((job) => !opts.onlySlug || job.slug === opts.onlySlug)
      .map((job) => ({
        job,
        retention: opts.perSlug?.[job.slug] ?? opts.global,
      }))
      .filter((x) => x.retention.maxAgeDays !== undefined)
      .map((x) => ({
        job: x.job,
        cutoff: new Date(
          nowMs - (x.retention.maxAgeDays as number) * 86_400_000,
        ).toISOString(),
      }));

    if (opts.dryRun) {
      for (const { job, cutoff } of plan) {
        const missed = await this.run(
          this.#q.pruneCountMissed(job.id, cutoff),
        );
        const requests = await this.run(
          this.#q.pruneCountRunRequests(job.id, cutoff),
        );
        const invs = await this.run(
          this.#q.pruneCountInvocations(job.id, cutoff, runningCutoff),
        );
        report.missedAlerts += reqNum(missed[0]!.n);
        report.runRequests += reqNum(requests[0]!.n);
        report.invocations += reqNum(invs[0]!.n);
      }
      return report;
    }

    await this.#sql.begin(async (tx) => {
      const exec = async (q: PgQuery) => tx.unsafe(q.text, q.values);
      for (const { job, cutoff } of plan) {
        // Bun.sql exposes affected-row count via the result array's `.count`
        // (the query returns no rows, so length is 0); read it defensively.
        const dm = await exec(this.#q.pruneDeleteMissed(job.id, cutoff));
        report.missedAlerts += affected(dm);
        const dr = await exec(this.#q.pruneDeleteRunRequests(job.id, cutoff));
        report.runRequests += affected(dr);
        // Sever surviving refs to doomed invocations before deleting them.
        await exec(
          this.#q.pruneNullRunRequestRefs(job.id, cutoff, runningCutoff),
        );
        const di = await exec(
          this.#q.pruneDeleteInvocations(job.id, cutoff, runningCutoff),
        );
        report.invocations += affected(di);
      }
    });
    return report;
  }
}

// Bun.sql attaches an affected-row `count` to the result of a mutating
// statement. It is not on the public type surface, so read it structurally and
// fall back to the row length (0 for a DELETE with no RETURNING).
function affected(result: Record<string, unknown>[]): number {
  const c = (result as unknown as { count?: number }).count;
  return typeof c === "number" ? c : result.length;
}
