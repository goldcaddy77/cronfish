// SQLite dialect query builders for cronfish.
//
// Every SQL string the SqliteStore runs lives here as a pure const or builder
// function — no ORM, no query-builder lib. This is the ONLY place that speaks
// bun:sqlite's `$name` named-param binding; a PostgresStore gets its own
// sibling module with `$1`-style params. The migration ladder (DDL steps) stays
// an array of builder fns operating on the raw Database, since SQLite migrations
// use PRAGMA table_info introspection and per-dialect DDL.

import type { Database } from "bun:sqlite";
import { scheduleKind, type ScheduleKind } from "../next-run.ts";

// --- Migration ladder (PRAGMA user_version step functions) ---

export type Migration = (db: Database) => void;

export const MIGRATIONS: Migration[] = [
  // v1 — initial ledger
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id             INTEGER PRIMARY KEY,
        slug           TEXT NOT NULL UNIQUE,
        kind           TEXT NOT NULL CHECK (kind IN ('md','ts','sh','py')),
        schedule       TEXT NOT NULL,
        enabled        INTEGER NOT NULL,
        timeout_s      INTEGER,
        retries        INTEGER NOT NULL DEFAULT 0,
        concurrency    TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency IN ('skip','queue')),
        model          TEXT,
        last_synced_at TEXT NOT NULL,
        deleted_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS cron_invocations (
        id          INTEGER PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES cron_jobs(id),
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        status      TEXT NOT NULL CHECK (status IN ('running','ok','fail','timeout','crashed')),
        exit_code   INTEGER,
        trigger     TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
        log_path    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inv_job_started ON cron_invocations(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inv_status_running ON cron_invocations(status) WHERE status = 'running';
    `);
  },
  // v2 — one-line description from frontmatter
  (db) => {
    // ALTER TABLE ADD COLUMN — wrapped because IF NOT EXISTS isn't supported
    // for ADD COLUMN in older sqlite. Check the column first.
    const cols = db.query("PRAGMA table_info(cron_jobs)").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "description")) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN description TEXT");
    }
  },
  // v3 — structured per-run results
  (db) => {
    const cols = db.query("PRAGMA table_info(cron_invocations)").all() as {
      name: string;
    }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("result_summary"))
      db.exec("ALTER TABLE cron_invocations ADD COLUMN result_summary TEXT");
    if (!have.has("result_ok"))
      db.exec("ALTER TABLE cron_invocations ADD COLUMN result_ok INTEGER");
    if (!have.has("result_json"))
      db.exec("ALTER TABLE cron_invocations ADD COLUMN result_json TEXT");
    if (!have.has("result_truncated"))
      db.exec(
        "ALTER TABLE cron_invocations ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0",
      );
  },
  // v4 — alert outcome per invocation
  (db) => {
    const cols = db.query("PRAGMA table_info(cron_invocations)").all() as {
      name: string;
    }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("alert_status"))
      db.exec("ALTER TABLE cron_invocations ADD COLUMN alert_status TEXT");
    if (!have.has("alert_error"))
      db.exec("ALTER TABLE cron_invocations ADD COLUMN alert_error TEXT");
  },
  // v5 — missed-schedule alerts table (watchdog dedup)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_missed_alerts (
        id          INTEGER PRIMARY KEY,
        job_id      INTEGER NOT NULL REFERENCES cron_jobs(id),
        expected_at TEXT NOT NULL,
        fired_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_missed_job_fired
        ON cron_missed_alerts(job_id, fired_at DESC);
    `);
  },
  // v6 — daemon scheduler state + first-class run-history reporting
  // (docs/v2-daemon.md). cron_jobs grows scheduler columns; cron_invocations
  // is rebuilt to widen the trigger CHECK with 'catchup' and gains
  // duration_ms/attempt/scheduled_for; run-request + heartbeat tables land.
  (db) => {
    const jobCols = db.query("PRAGMA table_info(cron_jobs)").all() as {
      name: string;
    }[];
    const have = new Set(jobCols.map((c) => c.name));
    const add = (col: string, ddl: string) => {
      if (!have.has(col)) db.exec(`ALTER TABLE cron_jobs ADD COLUMN ${ddl}`);
    };
    add(
      "state",
      "state TEXT CHECK (state IN ('active','disabled','deleted'))",
    );
    add("next_run_at", "next_run_at TEXT");
    add("last_run_at", "last_run_at TEXT");
    add("last_status", "last_status TEXT");
    add("file_path", "file_path TEXT");
    add("file_mtime", "file_mtime TEXT");
    // Change detection is size+mtime — mtime alone misses an mtime-preserving
    // replacement (`cp -p`).
    add("file_size", "file_size INTEGER");
    add(
      "schedule_kind",
      "schedule_kind TEXT CHECK (schedule_kind IN ('interval','cron','once','manual'))",
    );

    // Backfill state from the legacy enabled/deleted_at pair — state is the
    // one home going forward (written by sync), those stay for compatibility.
    db.exec(`
      UPDATE cron_jobs SET state = CASE
        WHEN deleted_at IS NOT NULL THEN 'deleted'
        WHEN enabled = 0 THEN 'disabled'
        ELSE 'active'
      END WHERE state IS NULL
    `);

    // Backfill schedule_kind from the stored schedule text; unparseable
    // legacy rows just stay NULL (the next sync rewrites them).
    const jobs = db
      .query("SELECT id, schedule FROM cron_jobs WHERE schedule_kind IS NULL")
      .all() as { id: number; schedule: string }[];
    for (const j of jobs) {
      let kind: ScheduleKind | null = null;
      try {
        kind = scheduleKind(j.schedule);
      } catch {}
      if (kind) {
        db.prepare(
          "UPDATE cron_jobs SET schedule_kind = $kind WHERE id = $id",
        ).run({ $kind: kind, $id: j.id });
      }
    }

    // Rebuild cron_invocations: SQLite can't ALTER a CHECK constraint, and
    // the trigger domain gains 'catchup'. Standard copy/drop/rename — nothing
    // references cron_invocations yet (cron_run_requests is created after).
    db.exec(`
      CREATE TABLE cron_invocations_v6 (
        id               INTEGER PRIMARY KEY,
        job_id           INTEGER NOT NULL REFERENCES cron_jobs(id),
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
        duration_ms      INTEGER,
        attempt          INTEGER NOT NULL DEFAULT 1,
        scheduled_for    TEXT
      );
      INSERT INTO cron_invocations_v6 (
        id, job_id, started_at, finished_at, status, exit_code, trigger,
        log_path, result_summary, result_ok, result_json, result_truncated,
        alert_status, alert_error
      )
      SELECT
        id, job_id, started_at, finished_at, status, exit_code, trigger,
        log_path, result_summary, result_ok, result_json, result_truncated,
        alert_status, alert_error
      FROM cron_invocations;
      DROP TABLE cron_invocations;
      ALTER TABLE cron_invocations_v6 RENAME TO cron_invocations;

      CREATE INDEX IF NOT EXISTS idx_inv_job_started ON cron_invocations(job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inv_status_running ON cron_invocations(status) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS idx_inv_started ON cron_invocations(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inv_status ON cron_invocations(status);
    `);

    // One-time backfill so historical rows report durations — going forward
    // finishInvocation writes duration_ms as an integer at finish time.
    db.exec(`
      UPDATE cron_invocations
      SET duration_ms = CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400000) AS INTEGER)
      WHERE finished_at IS NOT NULL AND duration_ms IS NULL
    `);

    // Backfill last_run_at from run history. Without this, every interval
    // job's schedule-change rule (next = max(now, last_run + interval)) sees
    // last_run = NULL right after the hot swap → all jobs fire at once.
    db.exec(`
      UPDATE cron_jobs
      SET last_run_at = (
        SELECT MAX(started_at) FROM cron_invocations i
        WHERE i.job_id = cron_jobs.id
      )
      WHERE last_run_at IS NULL
    `);

    // Manual-run queue the daemon drains ("the daemon is THE runner") and the
    // single-row heartbeat it upserts every tick.
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_run_requests (
        id            INTEGER PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES cron_jobs(id),
        trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual')),
        requested_at  TEXT NOT NULL,
        picked_up_at  TEXT,
        expired_at    TEXT,
        invocation_id INTEGER REFERENCES cron_invocations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_requests_pending
        ON cron_run_requests(requested_at) WHERE picked_up_at IS NULL;

      CREATE TABLE IF NOT EXISTS cron_daemon_heartbeat (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        pid          INTEGER NOT NULL,
        started_at   TEXT NOT NULL,
        last_tick_at TEXT NOT NULL,
        version      TEXT,
        tick_count   INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_due ON cron_jobs(state, next_run_at);
    `);
  },
];

// --- Jobs ---

export const SQLITE_UPSERT_JOB = `
  INSERT INTO cron_jobs (
    slug, kind, schedule, enabled, timeout_s, retries, concurrency,
    model, description, last_synced_at, deleted_at, state, schedule_kind,
    file_path, file_mtime, file_size
  ) VALUES (
    $slug, $kind, $schedule, $enabled, $timeout_s, $retries, $concurrency,
    $model, $description, $now, NULL, $state, $schedule_kind,
    $file_path, $file_mtime, $file_size
  )
  ON CONFLICT(slug) DO UPDATE SET
    kind = excluded.kind,
    schedule = excluded.schedule,
    enabled = excluded.enabled,
    timeout_s = excluded.timeout_s,
    retries = excluded.retries,
    concurrency = excluded.concurrency,
    model = excluded.model,
    description = excluded.description,
    last_synced_at = excluded.last_synced_at,
    deleted_at = NULL,
    state = excluded.state,
    schedule_kind = excluded.schedule_kind,
    file_path = excluded.file_path,
    file_mtime = COALESCE(excluded.file_mtime, cron_jobs.file_mtime),
    file_size = COALESCE(excluded.file_size, cron_jobs.file_size)
`;

export const SQLITE_MARK_DELETED_ALL =
  "UPDATE cron_jobs SET deleted_at = $now, state = 'deleted' WHERE deleted_at IS NULL";

// Placeholders are built per call (variable arity) — the caller assembles the
// `$s0,$s1,...` fragment and merges the params.
export function buildSqliteMarkDeletedExcept(slugCount: number): string {
  const placeholders = Array.from({ length: slugCount }, (_, i) => `$s${i}`).join(
    ",",
  );
  return `UPDATE cron_jobs SET deleted_at = $now, state = 'deleted' WHERE deleted_at IS NULL AND slug NOT IN (${placeholders})`;
}

export const SQLITE_JOB_ID_BY_SLUG =
  "SELECT id FROM cron_jobs WHERE slug = $slug";

export const SQLITE_LIST_ENABLED_JOBS = `SELECT id, slug, schedule FROM cron_jobs
   WHERE enabled = 1 AND deleted_at IS NULL`;

export const SQLITE_LIST_DUE_JOBS = `SELECT id, slug, kind, schedule, schedule_kind, next_run_at,
          last_run_at, concurrency, retries, timeout_s, file_path
   FROM cron_jobs
   WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= $now
   ORDER BY next_run_at ASC`;

export const SQLITE_LIST_JOB_SYNC_STATE = `SELECT id, slug, state, schedule, schedule_kind, file_mtime, file_size,
          next_run_at, last_run_at
   FROM cron_jobs
   WHERE state IS NULL OR state != 'deleted'`;

export const SQLITE_SET_JOB_NEXT_RUN =
  "UPDATE cron_jobs SET next_run_at = $next WHERE id = $id";

export const SQLITE_SET_JOB_LAST_RUN =
  "UPDATE cron_jobs SET last_run_at = $last, last_status = $status WHERE id = $id";

// --- Invocations ---

export const SQLITE_START_INVOCATION = `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path, attempt, scheduled_for)
   VALUES ($job_id, $now, 'running', $trigger, $log_path, $attempt, $scheduled_for)`;

export const SQLITE_INVOCATION_STARTED_AT =
  "SELECT started_at FROM cron_invocations WHERE id = $id";

export const SQLITE_FINISH_INVOCATION = `UPDATE cron_invocations
   SET finished_at = $now,
       status = $status,
       exit_code = $exit_code,
       duration_ms = $duration_ms,
       attempt = COALESCE($attempt, attempt),
       result_summary = $result_summary,
       result_ok = $result_ok,
       result_json = $result_json,
       result_truncated = $result_truncated
   WHERE id = $id`;

export const SQLITE_SET_INVOCATION_ALERT = `UPDATE cron_invocations
   SET alert_status = $status, alert_error = $error
   WHERE id = $id`;

export const SQLITE_SET_INVOCATION_LOG_PATH =
  "UPDATE cron_invocations SET log_path = $p WHERE id = $id";

export const SQLITE_GET_INVOCATION_LOG_PATH =
  "SELECT log_path FROM cron_invocations WHERE id = $id";

export const SQLITE_LAST_OK_STARTED_AT = `SELECT started_at FROM cron_invocations
   WHERE job_id = $job_id AND status = 'ok'
   ORDER BY started_at DESC LIMIT 1`;

export const SQLITE_PREVIOUS_FINISHED_STATUS = `SELECT status FROM cron_invocations
   WHERE job_id = $job_id
     AND id <> $id
     AND finished_at IS NOT NULL
   ORDER BY started_at DESC LIMIT 1`;

// --- Missed-run alerts ---

export const SQLITE_LATEST_MISSED_FIRED_AT = `SELECT fired_at FROM cron_missed_alerts
   WHERE job_id = $job_id
   ORDER BY fired_at DESC LIMIT 1`;

export const SQLITE_RECORD_MISSED_ALERT = `INSERT INTO cron_missed_alerts (job_id, expected_at, fired_at)
   VALUES ($job_id, $expected_at, $now)`;

// --- Run requests ---

export const SQLITE_INSERT_RUN_REQUEST = `INSERT INTO cron_run_requests (job_id, trigger, requested_at)
   VALUES ($job_id, 'manual', $now)`;

export const SQLITE_EXPIRE_STALE_RUN_REQUESTS = `UPDATE cron_run_requests SET expired_at = $now
   WHERE picked_up_at IS NULL AND expired_at IS NULL AND requested_at < $cutoff`;

export const SQLITE_SELECT_CLAIMABLE_RUN_REQUESTS = `SELECT r.id, r.job_id, j.slug, r.trigger, r.requested_at, j.file_path
   FROM cron_run_requests r
   JOIN cron_jobs j ON j.id = r.job_id
   WHERE r.picked_up_at IS NULL AND r.expired_at IS NULL
   ORDER BY r.requested_at ASC, r.id ASC`;

export const SQLITE_CLAIM_RUN_REQUEST =
  "UPDATE cron_run_requests SET picked_up_at = $now WHERE id = $id";

export const SQLITE_EXPIRE_RUN_REQUEST = `UPDATE cron_run_requests SET expired_at = $now
   WHERE id = $id AND expired_at IS NULL`;

export const SQLITE_CLEAR_RUN_REQUEST_CLAIM = `UPDATE cron_run_requests SET picked_up_at = NULL
   WHERE id = $id AND invocation_id IS NULL`;

export const SQLITE_LINK_RUN_REQUEST_INVOCATION =
  "UPDATE cron_run_requests SET invocation_id = $inv WHERE id = $id";

export const SQLITE_GET_RUN_REQUEST =
  "SELECT picked_up_at, invocation_id, expired_at FROM cron_run_requests WHERE id = $id";

// --- Heartbeat ---

export const SQLITE_BEAT_HEARTBEAT = `INSERT INTO cron_daemon_heartbeat (id, pid, started_at, last_tick_at, version, tick_count)
   VALUES (1, $pid, $started_at, $now, $version, 1)
   ON CONFLICT(id) DO UPDATE SET
     pid = excluded.pid,
     started_at = excluded.started_at,
     last_tick_at = excluded.last_tick_at,
     version = excluded.version,
     tick_count = CASE
       WHEN cron_daemon_heartbeat.pid = excluded.pid
        AND cron_daemon_heartbeat.started_at = excluded.started_at
       THEN cron_daemon_heartbeat.tick_count + 1
       ELSE 1
     END`;

export const SQLITE_GET_HEARTBEAT = `SELECT pid, started_at, last_tick_at, version, tick_count
   FROM cron_daemon_heartbeat WHERE id = 1`;

// --- Reporting ---

export const SQLITE_LIST_RUN_HISTORY = `SELECT i.id, j.slug, i.started_at, i.finished_at, i.status, i.trigger,
          i.attempt, i.duration_ms, i.scheduled_for, i.exit_code,
          i.result_summary, i.log_path
   FROM cron_invocations i
   JOIN cron_jobs j ON j.id = i.job_id
   WHERE ($slug IS NULL OR j.slug = $slug)
     AND ($since IS NULL OR i.started_at >= $since)
   ORDER BY i.started_at DESC, i.id DESC
   LIMIT $limit`;

export const SQLITE_JOB_STATS = `SELECT j.slug,
          COUNT(i.id) AS runs,
          COALESCE(SUM(i.status = 'ok'), 0) AS ok,
          COALESCE(SUM(i.status = 'fail'), 0) AS fail,
          COALESCE(SUM(i.status = 'timeout'), 0) AS timeout,
          COALESCE(SUM(i.finished_at IS NOT NULL), 0) AS finished,
          AVG(i.duration_ms) AS avg_duration_ms,
          COALESCE(j.last_run_at, MAX(i.started_at)) AS last_run_at,
          j.last_status
   FROM cron_jobs j
   LEFT JOIN cron_invocations i
     ON i.job_id = j.id AND ($since IS NULL OR i.started_at >= $since)
   WHERE j.state IS NULL OR j.state != 'deleted'
   GROUP BY j.id
   ORDER BY j.slug ASC`;

export const SQLITE_JOB_STATS_DURATIONS = `SELECT j.slug, i.duration_ms
   FROM cron_invocations i
   JOIN cron_jobs j ON j.id = i.job_id
   WHERE i.duration_ms IS NOT NULL
     AND ($since IS NULL OR i.started_at >= $since)
   ORDER BY j.slug ASC, i.duration_ms ASC`;

// --- UI / CLI read views (moved out of ui/server.ts + cli.ts) ---

// The julianday() duration math stays SQLite-specific — a PostgresStore
// computes the same value with its own dialect.
export const SQLITE_LIST_JOBS_WITH_LAST_INVOCATION = `
  SELECT j.*,
         last.status         AS last_status,
         last.started_at     AS last_started_at,
         last.finished_at    AS last_finished_at,
         last.exit_code      AS last_exit_code,
         last.id             AS last_invocation_id,
         CASE
           WHEN last.finished_at IS NULL THEN NULL
           ELSE CAST(
             (julianday(last.finished_at) - julianday(last.started_at)) * 86400000 AS INTEGER
           )
         END AS last_duration_ms
  FROM cron_jobs j
  LEFT JOIN cron_invocations last
    ON last.id = (
      SELECT id FROM cron_invocations
      WHERE job_id = j.id
      ORDER BY started_at DESC
      LIMIT 1
    )
  ORDER BY j.deleted_at IS NOT NULL, j.slug
`;

export const SQLITE_GET_JOB_BY_SLUG = "SELECT * FROM cron_jobs WHERE slug = ?";

export const SQLITE_LAST_INVOCATION_STARTED_AT = `SELECT i.started_at FROM cron_invocations i
   JOIN cron_jobs j ON j.id = i.job_id
   WHERE j.slug = ?
   ORDER BY i.started_at DESC LIMIT 1`;

export const SQLITE_LIST_INVOCATIONS_FOR_SLUG = `
  SELECT i.*,
    CASE
      WHEN i.finished_at IS NULL THEN NULL
      ELSE CAST(
        (julianday(i.finished_at) - julianday(i.started_at)) * 86400000 AS INTEGER
      )
    END AS duration_ms
  FROM cron_invocations i
  JOIN cron_jobs j ON j.id = i.job_id
  WHERE j.slug = ?
  ORDER BY i.started_at DESC
  LIMIT ?
`;

export const SQLITE_LIST_ALL_INVOCATIONS = `
  SELECT i.*, j.slug AS slug,
    CASE
      WHEN i.finished_at IS NULL THEN NULL
      ELSE CAST(
        (julianday(i.finished_at) - julianday(i.started_at)) * 86400000 AS INTEGER
      )
    END AS duration_ms
  FROM cron_invocations i
  JOIN cron_jobs j ON j.id = i.job_id
  ORDER BY i.started_at DESC
  LIMIT ?
`;

export const SQLITE_GET_INVOCATION_WITH_DURATION = `
  SELECT i.*, j.slug AS slug,
    CASE
      WHEN i.finished_at IS NULL THEN NULL
      ELSE CAST(
        (julianday(i.finished_at) - julianday(i.started_at)) * 86400000 AS INTEGER
      )
    END AS duration_ms
  FROM cron_invocations i
  JOIN cron_jobs j ON j.id = i.job_id
  WHERE i.id = ?
`;

export const SQLITE_LAST_RESULTS = `SELECT j.slug AS slug, i.result_summary AS result_summary, i.finished_at AS finished_at
   FROM cron_invocations i
   JOIN cron_jobs j ON j.id = i.job_id
   WHERE i.id IN (
     SELECT MAX(id) FROM cron_invocations GROUP BY job_id
   )`;

// --- Ledger prune (SQL fragments for the multi-DELETE transaction) ---

// The doomed-invocation predicate, shared by count/null-refs/delete so the
// three can never disagree. Bind: $job, $cutoff, $running_cutoff.
export const SQLITE_DOOMED_INVOCATION_PREDICATE = `job_id = $job AND started_at < $cutoff
      AND NOT (status = 'running' AND started_at >= $running_cutoff)`;

export const SQLITE_PRUNE_LIST_JOBS =
  "SELECT id, slug FROM cron_jobs ORDER BY slug";

export const SQLITE_PRUNE_COUNT_MISSED =
  "SELECT COUNT(*) AS n FROM cron_missed_alerts WHERE job_id = $job AND fired_at < $cutoff";

export const SQLITE_PRUNE_COUNT_RUN_REQUESTS =
  "SELECT COUNT(*) AS n FROM cron_run_requests WHERE job_id = $job AND requested_at < $cutoff";

export const SQLITE_PRUNE_COUNT_INVOCATIONS = `SELECT COUNT(*) AS n FROM cron_invocations WHERE ${SQLITE_DOOMED_INVOCATION_PREDICATE}`;

export const SQLITE_PRUNE_DELETE_MISSED =
  "DELETE FROM cron_missed_alerts WHERE job_id = $job AND fired_at < $cutoff";

export const SQLITE_PRUNE_DELETE_RUN_REQUESTS =
  "DELETE FROM cron_run_requests WHERE job_id = $job AND requested_at < $cutoff";

export const SQLITE_PRUNE_NULL_RUN_REQUEST_REFS = `UPDATE cron_run_requests SET invocation_id = NULL
           WHERE job_id = $job AND invocation_id IN
             (SELECT id FROM cron_invocations WHERE ${SQLITE_DOOMED_INVOCATION_PREDICATE})`;

export const SQLITE_PRUNE_DELETE_INVOCATIONS = `DELETE FROM cron_invocations WHERE ${SQLITE_DOOMED_INVOCATION_PREDICATE}`;
