// Postgres dialect query builders for cronfish.
//
// The sibling of sqlite-queries.ts: every SQL string the PostgresStore runs is
// built here, schema-qualified and injection-safe. Two dialect facts force a
// separate module from the SQLite builders:
//
//   - Positional params. Bun.sql (like every Postgres wire client) binds
//     parameters as `$1,$2,…` in statement order, not bun:sqlite's `$name`.
//     Every builder returns `{ text, values }` — the SQL text plus an ordered
//     values array — so the store passes them straight to `sql.unsafe(text,
//     values)`.
//   - Schema qualification. Every table lives in a configured schema; the
//     schema identifier is validated once (alnum/underscore) and interpolated
//     into the SQL text (identifiers can NEVER be bind params). This is the
//     injection guard — see `assertPgIdentifier`.
//
// Row SHAPES are kept byte-identical to SQLite: timestamps are TEXT ISO-8601,
// the 0/1 flag columns stay INTEGER (not BOOLEAN), so the shared JS consumers
// and the describe.each suite pass unchanged for both backends. Where SQLite
// does julianday() duration math, Postgres uses EXTRACT(EPOCH FROM (…)) over
// the TEXT columns cast to timestamptz.

import { scheduleKind, type ScheduleKind } from "../next-run.ts";

export interface PgQuery {
  text: string;
  values: unknown[];
}

const PG_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

// Validate a schema/table identifier before interpolating it into SQL text.
// Bind params can't carry identifiers, so this once-at-construction check is
// the injection guard. The strict pattern excludes the `"` char, so no
// quote-doubling is needed.
export function assertPgIdentifier(value: string, role = "schema"): void {
  if (!PG_IDENTIFIER.test(value)) {
    throw new Error(
      `cronfish postgres ${role} "${value}" is not a valid identifier — use letters, digits, and underscores, starting with a letter or underscore (${PG_IDENTIFIER.source}).`,
    );
  }
}

// The full set of query builders bound to one validated schema. Built once per
// PostgresStore; every table reference is `"<schema>"."<table>"`.
export function buildPostgresQueries(schema: string) {
  assertPgIdentifier(schema, "schema");
  const s = `"${schema}"`;
  const jobs = `${s}.cron_jobs`;
  const inv = `${s}.cron_invocations`;
  const req = `${s}.cron_run_requests`;
  const hb = `${s}.cron_daemon_heartbeat`;
  const missed = `${s}.cron_missed_alerts`;
  const migrations = `${s}.cron_migrations`;

  // Duration in ms between two TEXT ISO timestamp columns, matching SQLite's
  // `(julianday(b) - julianday(a)) * 86400000` rounded to an integer.
  const durMs = (a: string, b: string) =>
    `CAST(ROUND(EXTRACT(EPOCH FROM (${b}::timestamptz - ${a}::timestamptz)) * 1000) AS BIGINT)`;

  return {
    schema,
    tableRefs: { jobs, inv, req, hb, missed, migrations },

    // --- Migration bookkeeping ---
    createSchema: `CREATE SCHEMA IF NOT EXISTS ${s}`,
    createMigrationsTable: `CREATE TABLE IF NOT EXISTS ${migrations} (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
    maxMigrationVersion: `SELECT COALESCE(MAX(version), 0) AS version FROM ${migrations}`,
    recordMigration: (version: number, appliedAt: string): PgQuery => ({
      text: `INSERT INTO ${migrations} (version, applied_at) VALUES ($1, $2)`,
      values: [version, appliedAt],
    }),

    // --- The one-shot v6-equivalent end-state schema (migration #1) ---
    // A Postgres store is always FRESH — no legacy SQLite data to evolve — so
    // step 1 creates the FINAL schema directly rather than replaying v1→v6.
    createFinalSchema: [
      `CREATE TABLE IF NOT EXISTS ${jobs} (
        id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        slug           TEXT NOT NULL UNIQUE,
        kind           TEXT NOT NULL CHECK (kind IN ('md','ts','sh','py')),
        schedule       TEXT NOT NULL,
        enabled        INTEGER NOT NULL,
        timeout_s      INTEGER,
        retries        INTEGER NOT NULL DEFAULT 0,
        concurrency    TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency IN ('skip','queue')),
        model          TEXT,
        description    TEXT,
        last_synced_at TEXT NOT NULL,
        deleted_at     TEXT,
        state          TEXT CHECK (state IN ('active','disabled','deleted')),
        next_run_at    TEXT,
        last_run_at    TEXT,
        last_status    TEXT,
        file_path      TEXT,
        file_mtime     TEXT,
        file_size      INTEGER,
        schedule_kind  TEXT CHECK (schedule_kind IN ('interval','cron','once','manual'))
      )`,
      `CREATE TABLE IF NOT EXISTS ${inv} (
        id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id           BIGINT NOT NULL REFERENCES ${jobs}(id),
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        status           TEXT NOT NULL CHECK (status IN ('running','ok','fail','timeout','crashed')),
        exit_code        INTEGER,
        trigger          TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry','catchup')),
        log_path         TEXT NOT NULL,
        result_summary   TEXT,
        result_ok        INTEGER,
        result_json      TEXT,
        result_truncated INTEGER NOT NULL DEFAULT 0,
        alert_status     TEXT,
        alert_error      TEXT,
        duration_ms      BIGINT,
        attempt          INTEGER NOT NULL DEFAULT 1,
        scheduled_for    TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_inv_job_started ON ${inv}(job_id, started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_inv_status_running ON ${inv}(status) WHERE status = 'running'`,
      `CREATE INDEX IF NOT EXISTS idx_inv_started ON ${inv}(started_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_inv_status ON ${inv}(status)`,
      `CREATE TABLE IF NOT EXISTS ${req} (
        id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id        BIGINT NOT NULL REFERENCES ${jobs}(id),
        trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual')),
        requested_at  TEXT NOT NULL,
        picked_up_at  TEXT,
        expired_at    TEXT,
        invocation_id BIGINT REFERENCES ${inv}(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_run_requests_pending ON ${req}(requested_at) WHERE picked_up_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS ${hb} (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        pid          INTEGER NOT NULL,
        started_at   TEXT NOT NULL,
        last_tick_at TEXT NOT NULL,
        version      TEXT,
        tick_count   INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS ${missed} (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id      BIGINT NOT NULL REFERENCES ${jobs}(id),
        expected_at TEXT NOT NULL,
        fired_at    TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_missed_job_fired ON ${missed}(job_id, fired_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_due ON ${jobs}(state, next_run_at)`,
    ],

    // --- Jobs ---
    upsertJob: (p: {
      slug: string;
      kind: string;
      schedule: string;
      enabled: number;
      timeout_s: number | null;
      retries: number;
      concurrency: string;
      model: string | null;
      description: string | null;
      now: string;
      state: string;
      schedule_kind: string | null;
      file_path: string | null;
      file_mtime: string | null;
      file_size: number | null;
    }): PgQuery => ({
      text: `INSERT INTO ${jobs} (
        slug, kind, schedule, enabled, timeout_s, retries, concurrency,
        model, description, last_synced_at, deleted_at, state, schedule_kind,
        file_path, file_mtime, file_size
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, NULL, $11, $12,
        $13, $14, $15
      )
      ON CONFLICT(slug) DO UPDATE SET
        kind = EXCLUDED.kind,
        schedule = EXCLUDED.schedule,
        enabled = EXCLUDED.enabled,
        timeout_s = EXCLUDED.timeout_s,
        retries = EXCLUDED.retries,
        concurrency = EXCLUDED.concurrency,
        model = EXCLUDED.model,
        description = EXCLUDED.description,
        last_synced_at = EXCLUDED.last_synced_at,
        deleted_at = NULL,
        state = EXCLUDED.state,
        schedule_kind = EXCLUDED.schedule_kind,
        file_path = EXCLUDED.file_path,
        file_mtime = COALESCE(EXCLUDED.file_mtime, ${jobs}.file_mtime),
        file_size = COALESCE(EXCLUDED.file_size, ${jobs}.file_size)`,
      values: [
        p.slug, p.kind, p.schedule, p.enabled, p.timeout_s, p.retries,
        p.concurrency, p.model, p.description, p.now, p.state, p.schedule_kind,
        p.file_path, p.file_mtime, p.file_size,
      ],
    }),

    markDeletedAll: (now: string): PgQuery => ({
      text: `UPDATE ${jobs} SET deleted_at = $1, state = 'deleted' WHERE deleted_at IS NULL`,
      values: [now],
    }),
    markDeletedExcept: (now: string, slugs: string[]): PgQuery => {
      const placeholders = slugs.map((_, i) => `$${i + 2}`).join(",");
      return {
        text: `UPDATE ${jobs} SET deleted_at = $1, state = 'deleted' WHERE deleted_at IS NULL AND slug NOT IN (${placeholders})`,
        values: [now, ...slugs],
      };
    },
    jobIdBySlug: (slug: string): PgQuery => ({
      text: `SELECT id FROM ${jobs} WHERE slug = $1`,
      values: [slug],
    }),
    listEnabledJobs: (): PgQuery => ({
      text: `SELECT id, slug, schedule FROM ${jobs} WHERE enabled = 1 AND deleted_at IS NULL`,
      values: [],
    }),
    listDueJobs: (now: string): PgQuery => ({
      text: `SELECT id, slug, kind, schedule, schedule_kind, next_run_at,
              last_run_at, concurrency, retries, timeout_s, file_path
       FROM ${jobs}
       WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= $1
       ORDER BY next_run_at ASC`,
      values: [now],
    }),
    listJobSyncState: (): PgQuery => ({
      text: `SELECT id, slug, state, schedule, schedule_kind, file_mtime, file_size,
              next_run_at, last_run_at
       FROM ${jobs}
       WHERE state IS NULL OR state != 'deleted'`,
      values: [],
    }),
    setJobNextRun: (id: number, next: string | null): PgQuery => ({
      text: `UPDATE ${jobs} SET next_run_at = $1 WHERE id = $2`,
      values: [next, id],
    }),
    setJobLastRun: (id: number, last: string, status: string): PgQuery => ({
      text: `UPDATE ${jobs} SET last_run_at = $1, last_status = $2 WHERE id = $3`,
      values: [last, status, id],
    }),

    // --- Invocations ---
    startInvocation: (p: {
      job_id: number;
      now: string;
      trigger: string;
      log_path: string;
      attempt: number;
      scheduled_for: string | null;
    }): PgQuery => ({
      text: `INSERT INTO ${inv} (job_id, started_at, status, trigger, log_path, attempt, scheduled_for)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id`,
      values: [p.job_id, p.now, p.trigger, p.log_path, p.attempt, p.scheduled_for],
    }),
    invocationStartedAt: (id: number): PgQuery => ({
      text: `SELECT started_at FROM ${inv} WHERE id = $1`,
      values: [id],
    }),
    finishInvocation: (p: {
      id: number;
      now: string;
      status: string;
      exit_code: number | null;
      duration_ms: number | null;
      attempt: number | null;
      result_summary: string | null;
      result_ok: number | null;
      result_json: string | null;
      result_truncated: number;
    }): PgQuery => ({
      text: `UPDATE ${inv}
       SET finished_at = $1,
           status = $2,
           exit_code = $3,
           duration_ms = $4,
           attempt = COALESCE($5, attempt),
           result_summary = $6,
           result_ok = $7,
           result_json = $8,
           result_truncated = $9
       WHERE id = $10`,
      values: [
        p.now, p.status, p.exit_code, p.duration_ms, p.attempt,
        p.result_summary, p.result_ok, p.result_json, p.result_truncated, p.id,
      ],
    }),
    setInvocationAlert: (
      id: number,
      status: string,
      error: string | null,
    ): PgQuery => ({
      text: `UPDATE ${inv} SET alert_status = $1, alert_error = $2 WHERE id = $3`,
      values: [status, error, id],
    }),
    setInvocationLogPath: (id: number, logPath: string): PgQuery => ({
      text: `UPDATE ${inv} SET log_path = $1 WHERE id = $2`,
      values: [logPath, id],
    }),
    getInvocationLogPath: (id: number): PgQuery => ({
      text: `SELECT log_path FROM ${inv} WHERE id = $1`,
      values: [id],
    }),
    lastOkStartedAt: (jobId: number): PgQuery => ({
      text: `SELECT started_at FROM ${inv}
       WHERE job_id = $1 AND status = 'ok'
       ORDER BY started_at DESC LIMIT 1`,
      values: [jobId],
    }),
    previousFinishedStatus: (jobId: number, excludingId: number): PgQuery => ({
      text: `SELECT status FROM ${inv}
       WHERE job_id = $1 AND id <> $2 AND finished_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
      values: [jobId, excludingId],
    }),

    // --- Missed-run alerts ---
    latestMissedFiredAt: (jobId: number): PgQuery => ({
      text: `SELECT fired_at FROM ${missed} WHERE job_id = $1 ORDER BY fired_at DESC LIMIT 1`,
      values: [jobId],
    }),
    recordMissedAlert: (
      jobId: number,
      expectedAt: string,
      now: string,
    ): PgQuery => ({
      text: `INSERT INTO ${missed} (job_id, expected_at, fired_at) VALUES ($1, $2, $3) RETURNING id`,
      values: [jobId, expectedAt, now],
    }),

    // --- Run requests ---
    insertRunRequest: (jobId: number, now: string): PgQuery => ({
      text: `INSERT INTO ${req} (job_id, trigger, requested_at) VALUES ($1, 'manual', $2) RETURNING id`,
      values: [jobId, now],
    }),
    expireStaleRunRequests: (now: string, cutoff: string): PgQuery => ({
      text: `UPDATE ${req} SET expired_at = $1
       WHERE picked_up_at IS NULL AND expired_at IS NULL AND requested_at < $2`,
      values: [now, cutoff],
    }),
    // Single-statement CAS claim: lock + claim all currently-pending rows and
    // return them joined to their job for slug/file_path. Concurrent callers
    // get disjoint sets because the UPDATE row-locks each claimed row.
    claimRunRequests: (now: string): PgQuery => ({
      text: `UPDATE ${req} r
       SET picked_up_at = $1
       FROM ${jobs} j
       WHERE j.id = r.job_id
         AND r.picked_up_at IS NULL AND r.expired_at IS NULL
       RETURNING r.id, r.job_id, j.slug, r.trigger, r.requested_at, j.file_path`,
      values: [now],
    }),
    expireRunRequest: (id: number, now: string): PgQuery => ({
      text: `UPDATE ${req} SET expired_at = $1 WHERE id = $2 AND expired_at IS NULL`,
      values: [now, id],
    }),
    clearRunRequestClaim: (id: number): PgQuery => ({
      text: `UPDATE ${req} SET picked_up_at = NULL WHERE id = $1 AND invocation_id IS NULL`,
      values: [id],
    }),
    linkRunRequestInvocation: (id: number, inv: number): PgQuery => ({
      text: `UPDATE ${req} SET invocation_id = $1 WHERE id = $2`,
      values: [inv, id],
    }),
    getRunRequest: (id: number): PgQuery => ({
      text: `SELECT picked_up_at, invocation_id, expired_at FROM ${req} WHERE id = $1`,
      values: [id],
    }),

    // --- Heartbeat ---
    beatHeartbeat: (p: {
      pid: number;
      started_at: string;
      now: string;
      version: string | null;
    }): PgQuery => ({
      text: `INSERT INTO ${hb} (id, pid, started_at, last_tick_at, version, tick_count)
       VALUES (1, $1, $2, $3, $4, 1)
       ON CONFLICT(id) DO UPDATE SET
         pid = EXCLUDED.pid,
         started_at = EXCLUDED.started_at,
         last_tick_at = EXCLUDED.last_tick_at,
         version = EXCLUDED.version,
         tick_count = CASE
           WHEN ${hb}.pid = EXCLUDED.pid
            AND ${hb}.started_at = EXCLUDED.started_at
           THEN ${hb}.tick_count + 1
           ELSE 1
         END`,
      values: [p.pid, p.started_at, p.now, p.version],
    }),
    getHeartbeat: (): PgQuery => ({
      text: `SELECT pid, started_at, last_tick_at, version, tick_count FROM ${hb} WHERE id = 1`,
      values: [],
    }),

    // --- Reporting ---
    listRunHistory: (
      slug: string | null,
      since: string | null,
      limit: number,
    ): PgQuery => ({
      text: `SELECT i.id, j.slug, i.started_at, i.finished_at, i.status, i.trigger,
              i.attempt, i.duration_ms, i.scheduled_for, i.exit_code,
              i.result_summary, i.log_path
       FROM ${inv} i
       JOIN ${jobs} j ON j.id = i.job_id
       WHERE ($1::text IS NULL OR j.slug = $1)
         AND ($2::text IS NULL OR i.started_at >= $2)
       ORDER BY i.started_at DESC, i.id DESC
       LIMIT $3`,
      values: [slug, since, limit],
    }),
    // SUM(bool) → COUNT(*) FILTER (…); the SQLite `finished` count follows the
    // same rewrite. Aggregates match the exact numeric results.
    jobStats: (since: string | null): PgQuery => ({
      text: `SELECT j.slug,
              COUNT(i.id) AS runs,
              COUNT(*) FILTER (WHERE i.status = 'ok') AS ok,
              COUNT(*) FILTER (WHERE i.status = 'fail') AS fail,
              COUNT(*) FILTER (WHERE i.status = 'timeout') AS timeout,
              COUNT(*) FILTER (WHERE i.finished_at IS NOT NULL) AS finished,
              AVG(i.duration_ms) AS avg_duration_ms,
              COALESCE(j.last_run_at, MAX(i.started_at)) AS last_run_at,
              j.last_status
       FROM ${jobs} j
       LEFT JOIN ${inv} i
         ON i.job_id = j.id AND ($1::text IS NULL OR i.started_at >= $1)
       WHERE j.state IS NULL OR j.state != 'deleted'
       GROUP BY j.id, j.slug, j.last_run_at, j.last_status
       ORDER BY j.slug ASC`,
      values: [since],
    }),
    jobStatsDurations: (since: string | null): PgQuery => ({
      text: `SELECT j.slug, i.duration_ms
       FROM ${inv} i
       JOIN ${jobs} j ON j.id = i.job_id
       WHERE i.duration_ms IS NOT NULL
         AND ($1::text IS NULL OR i.started_at >= $1)
       ORDER BY j.slug ASC, i.duration_ms ASC`,
      values: [since],
    }),

    // --- UI / CLI read views ---
    listJobsWithLastInvocation: (): PgQuery => ({
      text: `SELECT j.*,
             last.status         AS last_status,
             last.started_at     AS last_started_at,
             last.finished_at    AS last_finished_at,
             last.exit_code      AS last_exit_code,
             last.id             AS last_invocation_id,
             CASE
               WHEN last.finished_at IS NULL THEN NULL
               ELSE ${durMs("last.started_at", "last.finished_at")}
             END AS last_duration_ms
      FROM ${jobs} j
      LEFT JOIN ${inv} last
        ON last.id = (
          SELECT id FROM ${inv}
          WHERE job_id = j.id
          ORDER BY started_at DESC
          LIMIT 1
        )
      ORDER BY (j.deleted_at IS NOT NULL), j.slug`,
      values: [],
    }),
    getJobBySlug: (slug: string): PgQuery => ({
      text: `SELECT * FROM ${jobs} WHERE slug = $1`,
      values: [slug],
    }),
    lastInvocationStartedAt: (slug: string): PgQuery => ({
      text: `SELECT i.started_at FROM ${inv} i
       JOIN ${jobs} j ON j.id = i.job_id
       WHERE j.slug = $1
       ORDER BY i.started_at DESC LIMIT 1`,
      values: [slug],
    }),
    listInvocationsForSlug: (slug: string, limit: number): PgQuery => ({
      text: `SELECT i.*,
        CASE
          WHEN i.finished_at IS NULL THEN NULL
          ELSE ${durMs("i.started_at", "i.finished_at")}
        END AS duration_ms
      FROM ${inv} i
      JOIN ${jobs} j ON j.id = i.job_id
      WHERE j.slug = $1
      ORDER BY i.started_at DESC
      LIMIT $2`,
      values: [slug, limit],
    }),
    listAllInvocations: (limit: number): PgQuery => ({
      text: `SELECT i.*, j.slug AS slug,
        CASE
          WHEN i.finished_at IS NULL THEN NULL
          ELSE ${durMs("i.started_at", "i.finished_at")}
        END AS duration_ms
      FROM ${inv} i
      JOIN ${jobs} j ON j.id = i.job_id
      ORDER BY i.started_at DESC
      LIMIT $1`,
      values: [limit],
    }),
    getInvocationWithDuration: (id: number): PgQuery => ({
      text: `SELECT i.*, j.slug AS slug,
        CASE
          WHEN i.finished_at IS NULL THEN NULL
          ELSE ${durMs("i.started_at", "i.finished_at")}
        END AS duration_ms
      FROM ${inv} i
      JOIN ${jobs} j ON j.id = i.job_id
      WHERE i.id = $1`,
      values: [id],
    }),
    lastResults: (): PgQuery => ({
      text: `SELECT j.slug AS slug, i.result_summary AS result_summary, i.finished_at AS finished_at
       FROM ${inv} i
       JOIN ${jobs} j ON j.id = i.job_id
       WHERE i.id IN (SELECT MAX(id) FROM ${inv} GROUP BY job_id)`,
      values: [],
    }),

    // --- Ledger prune ---
    // The doomed-invocation predicate, shared by count/null-refs/delete so the
    // three can never disagree. Params: $1 job, $2 cutoff, $3 running_cutoff.
    doomedPredicate: `job_id = $1 AND started_at < $2
      AND NOT (status = 'running' AND started_at >= $3)`,
    pruneListJobs: (): PgQuery => ({
      text: `SELECT id, slug FROM ${jobs} ORDER BY slug`,
      values: [],
    }),
    pruneCountMissed: (job: number, cutoff: string): PgQuery => ({
      text: `SELECT COUNT(*) AS n FROM ${missed} WHERE job_id = $1 AND fired_at < $2`,
      values: [job, cutoff],
    }),
    pruneCountRunRequests: (job: number, cutoff: string): PgQuery => ({
      text: `SELECT COUNT(*) AS n FROM ${req} WHERE job_id = $1 AND requested_at < $2`,
      values: [job, cutoff],
    }),
    pruneCountInvocations: (
      job: number,
      cutoff: string,
      runningCutoff: string,
    ): PgQuery => ({
      text: `SELECT COUNT(*) AS n FROM ${inv} WHERE job_id = $1 AND started_at < $2
        AND NOT (status = 'running' AND started_at >= $3)`,
      values: [job, cutoff, runningCutoff],
    }),
    pruneDeleteMissed: (job: number, cutoff: string): PgQuery => ({
      text: `DELETE FROM ${missed} WHERE job_id = $1 AND fired_at < $2`,
      values: [job, cutoff],
    }),
    pruneDeleteRunRequests: (job: number, cutoff: string): PgQuery => ({
      text: `DELETE FROM ${req} WHERE job_id = $1 AND requested_at < $2`,
      values: [job, cutoff],
    }),
    pruneNullRunRequestRefs: (
      job: number,
      cutoff: string,
      runningCutoff: string,
    ): PgQuery => ({
      text: `UPDATE ${req} SET invocation_id = NULL
           WHERE job_id = $1 AND invocation_id IN
             (SELECT id FROM ${inv} WHERE job_id = $1 AND started_at < $2
               AND NOT (status = 'running' AND started_at >= $3))`,
      values: [job, cutoff, runningCutoff],
    }),
    pruneDeleteInvocations: (
      job: number,
      cutoff: string,
      runningCutoff: string,
    ): PgQuery => ({
      text: `DELETE FROM ${inv} WHERE job_id = $1 AND started_at < $2
        AND NOT (status = 'running' AND started_at >= $3)`,
      values: [job, cutoff, runningCutoff],
    }),
  };
}

export type PostgresQueries = ReturnType<typeof buildPostgresQueries>;

// Backfill schedule_kind from a stored schedule string — same helper the
// SQLite v6 migration used, exposed for parity (unused by the fresh Postgres
// ladder but kept so the two dialects stay conceptually aligned).
export function scheduleKindOrNull(schedule: string): ScheduleKind | null {
  try {
    return scheduleKind(schedule);
  } catch {
    return null;
  }
}
