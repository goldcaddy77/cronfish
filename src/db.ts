// SQLite ledger for cronfish.
//
// Lives at <consumer-root>/.cronfish/db.sqlite via bun:sqlite (zero native dep).
// Migrations are a hand-rolled PRAGMA user_version step ladder — do NOT bring
// in Drizzle. Every write is failure-safe: callers wrap in try/catch and a DB
// failure logs one stderr warning, never aborts a cron run.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobMeta } from "./jobs.ts";
import { scheduleKind, type ScheduleKind } from "./next-run.ts";

export type InvocationStatus =
  | "running"
  | "ok"
  | "fail"
  | "timeout"
  | "crashed";
// 'catchup' = the single coalesced post-downtime run (docs/v2-daemon.md).
export type InvocationTrigger = "schedule" | "manual" | "retry" | "catchup";
export type JobState = "active" | "disabled" | "deleted";

export function dbPath(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "db.sqlite");
}

export function logsRoot(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "logs");
}

export function openDb(consumerRoot: string): Database {
  const path = dbPath(consumerRoot);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

type Migration = (db: Database) => void;

const MIGRATIONS: Migration[] = [
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

    // Manual-run queue the daemon drains ("the daemon is THE runner") and the
    // single-row heartbeat it upserts every tick.
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_run_requests (
        id            INTEGER PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES cron_jobs(id),
        trigger       TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual')),
        requested_at  TEXT NOT NULL,
        picked_up_at  TEXT,
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

export type AlertLedgerStatus = "sent" | "skipped" | "error" | "recovered";

// `upTo` is test-only: builds a db as it existed at an older ladder rung so
// migration tests can verify the fresh-db and upgraded-db paths converge.
export function migrate(db: Database, upTo?: number): void {
  const target = upTo ?? MIGRATIONS.length;
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  for (let v = current; v < target; v++) {
    const step = MIGRATIONS[v];
    db.transaction(() => {
      step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function scheduleAsText(schedule: JobMeta["schedule"]): string {
  if (schedule === undefined) return "manual";
  return String(schedule);
}

// `fileMtimeIso` is the job file's mtime, when the caller has it (the
// daemon's mtime scan) — omitted, the stored value is left untouched.
export function upsertJob(
  db: Database,
  job: JobMeta,
  fileMtimeIso?: string,
): void {
  // schedule_kind mirrors the schedule text; `manual` in scheduleAsText
  // covers the schedule-less case, so a parse failure just stores NULL.
  let kind: ScheduleKind | null = null;
  try {
    kind = scheduleKind(scheduleAsText(job.schedule));
  } catch {}
  const stmt = db.prepare(`
    INSERT INTO cron_jobs (
      slug, kind, schedule, enabled, timeout_s, retries, concurrency,
      model, description, last_synced_at, deleted_at, state, schedule_kind,
      file_path, file_mtime
    ) VALUES (
      $slug, $kind, $schedule, $enabled, $timeout_s, $retries, $concurrency,
      $model, $description, $now, NULL, $state, $schedule_kind,
      $file_path, $file_mtime
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
      file_mtime = COALESCE(excluded.file_mtime, cron_jobs.file_mtime)
  `);
  stmt.run({
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
  });
}

export function markDeleted(db: Database, slugsPresent: string[]): void {
  const now = nowIso();
  if (slugsPresent.length === 0) {
    db.prepare(
      "UPDATE cron_jobs SET deleted_at = $now, state = 'deleted' WHERE deleted_at IS NULL",
    ).run({
      $now: now,
    });
    return;
  }
  const placeholders = slugsPresent.map((_, i) => `$s${i}`).join(",");
  const params: Record<string, string> = { $now: now };
  slugsPresent.forEach((s, i) => (params[`$s${i}`] = s));
  db.prepare(
    `UPDATE cron_jobs SET deleted_at = $now, state = 'deleted' WHERE deleted_at IS NULL AND slug NOT IN (${placeholders})`,
  ).run(params);
}

export function getJobIdBySlug(db: Database, slug: string): number | null {
  const row = db
    .query("SELECT id FROM cron_jobs WHERE slug = $slug")
    .get({ $slug: slug }) as { id: number } | undefined;
  return row?.id ?? null;
}

export function startInvocation(
  db: Database,
  jobId: number,
  trigger: InvocationTrigger,
  logPath: string,
  opts?: {
    attempt?: number; // 1-based retry number; defaults to 1 (first try)
    scheduledFor?: string; // planned fire time — enables lateness reporting
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path, attempt, scheduled_for)
       VALUES ($job_id, $now, 'running', $trigger, $log_path, $attempt, $scheduled_for)`,
    )
    .run({
      $job_id: jobId,
      $now: nowIso(),
      $trigger: trigger,
      $log_path: logPath,
      $attempt: opts?.attempt ?? 1,
      $scheduled_for: opts?.scheduledFor ?? null,
    });
  return Number(res.lastInsertRowid);
}

export interface InvocationResultRow {
  summary: string | null;
  ok: boolean | null;
  json: string | null;
  truncated: boolean;
}

export function finishInvocation(
  db: Database,
  invocationId: number,
  status: InvocationStatus,
  exitCode: number | null,
  result?: InvocationResultRow,
): void {
  // duration_ms is materialized at finish time so reporting never does TEXT
  // date math at query time.
  const now = nowIso();
  const startedRow = db
    .query("SELECT started_at FROM cron_invocations WHERE id = $id")
    .get({ $id: invocationId }) as { started_at: string } | undefined;
  const durationMs = startedRow
    ? Math.max(0, Date.parse(now) - Date.parse(startedRow.started_at))
    : null;
  db.prepare(
    `UPDATE cron_invocations
     SET finished_at = $now,
         status = $status,
         exit_code = $exit_code,
         duration_ms = $duration_ms,
         result_summary = $result_summary,
         result_ok = $result_ok,
         result_json = $result_json,
         result_truncated = $result_truncated
     WHERE id = $id`,
  ).run({
    $id: invocationId,
    $now: now,
    $duration_ms: durationMs,
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

export function setInvocationAlert(
  db: Database,
  invocationId: number,
  status: AlertLedgerStatus,
  error: string | null,
): void {
  db.prepare(
    `UPDATE cron_invocations
     SET alert_status = $status, alert_error = $error
     WHERE id = $id`,
  ).run({ $id: invocationId, $status: status, $error: error });
}

export interface EnabledJobRow {
  id: number;
  slug: string;
  schedule: string;
}

export function listEnabledJobs(db: Database): EnabledJobRow[] {
  return db
    .query(
      `SELECT id, slug, schedule FROM cron_jobs
       WHERE enabled = 1 AND deleted_at IS NULL`,
    )
    .all() as EnabledJobRow[];
}

export function getLastOkStartedAt(
  db: Database,
  jobId: number,
): string | null {
  const row = db
    .query(
      `SELECT started_at FROM cron_invocations
       WHERE job_id = $job_id AND status = 'ok'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get({ $job_id: jobId }) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}

export function getLatestMissedFiredAt(
  db: Database,
  jobId: number,
): string | null {
  const row = db
    .query(
      `SELECT fired_at FROM cron_missed_alerts
       WHERE job_id = $job_id
       ORDER BY fired_at DESC LIMIT 1`,
    )
    .get({ $job_id: jobId }) as { fired_at: string } | undefined;
  return row?.fired_at ?? null;
}

export function recordMissedAlert(
  db: Database,
  jobId: number,
  expectedAtIso: string,
): number {
  const res = db
    .prepare(
      `INSERT INTO cron_missed_alerts (job_id, expected_at, fired_at)
       VALUES ($job_id, $expected_at, $now)`,
    )
    .run({
      $job_id: jobId,
      $expected_at: expectedAtIso,
      $now: nowIso(),
    });
  return Number(res.lastInsertRowid);
}

// Most recent finished invocation for a job (excluding the given id).
// Used by the runner to decide whether the current ok run is a recovery.
export function getPreviousFinishedStatus(
  db: Database,
  jobId: number,
  excludingId: number,
): InvocationStatus | null {
  const row = db
    .query(
      `SELECT status FROM cron_invocations
       WHERE job_id = $job_id
         AND id <> $id
         AND finished_at IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get({ $job_id: jobId, $id: excludingId }) as
    | { status: InvocationStatus }
    | undefined;
  return row?.status ?? null;
}

// --- v2 daemon: scheduler state ---

export interface DueJobRow {
  id: number;
  slug: string;
  kind: string;
  schedule: string;
  schedule_kind: ScheduleKind | null;
  next_run_at: string;
  last_run_at: string | null;
  concurrency: string;
  retries: number;
  timeout_s: number | null;
}

// The daemon's per-tick due query: everything active whose next_run_at has
// arrived. Disabled/deleted jobs and manual-only jobs (NULL next_run_at)
// never surface here. Served by idx_jobs_due(state, next_run_at).
export function listDueJobs(db: Database, nowIsoStr: string): DueJobRow[] {
  return db
    .query(
      `SELECT id, slug, kind, schedule, schedule_kind, next_run_at,
              last_run_at, concurrency, retries, timeout_s
       FROM cron_jobs
       WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= $now
       ORDER BY next_run_at ASC`,
    )
    .all({ $now: nowIsoStr }) as DueJobRow[];
}

export function setJobNextRun(
  db: Database,
  jobId: number,
  nextRunAtIso: string | null,
): void {
  db.prepare("UPDATE cron_jobs SET next_run_at = $next WHERE id = $id").run({
    $id: jobId,
    $next: nextRunAtIso,
  });
}

export function setJobLastRun(
  db: Database,
  jobId: number,
  lastRunAtIso: string,
  lastStatus: InvocationStatus,
): void {
  db.prepare(
    "UPDATE cron_jobs SET last_run_at = $last, last_status = $status WHERE id = $id",
  ).run({ $id: jobId, $last: lastRunAtIso, $status: lastStatus });
}

// --- v2 daemon: manual run requests ---

export interface RunRequestRow {
  id: number;
  job_id: number;
  slug: string;
  trigger: "manual";
  requested_at: string;
}

// `cron run <slug>` inserts one; the daemon drains them next tick.
export function insertRunRequest(db: Database, jobId: number): number {
  const res = db
    .prepare(
      `INSERT INTO cron_run_requests (job_id, trigger, requested_at)
       VALUES ($job_id, 'manual', $now)`,
    )
    .run({ $job_id: jobId, $now: nowIso() });
  return Number(res.lastInsertRowid);
}

// Claim every pending request atomically: mark picked_up_at, return the
// claimed rows. A second drain in the same tick (or a racing process) gets
// nothing — picked_up_at is the claim.
export function claimPendingRunRequests(db: Database): RunRequestRow[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT r.id, r.job_id, j.slug, r.trigger, r.requested_at
         FROM cron_run_requests r
         JOIN cron_jobs j ON j.id = r.job_id
         WHERE r.picked_up_at IS NULL
         ORDER BY r.requested_at ASC, r.id ASC`,
      )
      .all() as RunRequestRow[];
    const claim = db.prepare(
      "UPDATE cron_run_requests SET picked_up_at = $now WHERE id = $id",
    );
    const now = nowIso();
    for (const r of rows) claim.run({ $id: r.id, $now: now });
    return rows;
  })();
}

// Tie a claimed request to the invocation it produced — the audit link from
// `cron run` to the run history.
export function linkRunRequestInvocation(
  db: Database,
  requestId: number,
  invocationId: number,
): void {
  db.prepare(
    "UPDATE cron_run_requests SET invocation_id = $inv WHERE id = $id",
  ).run({ $id: requestId, $inv: invocationId });
}

// --- v2 daemon: heartbeat ---

export interface DaemonHeartbeatRow {
  pid: number;
  started_at: string;
  last_tick_at: string;
  version: string | null;
  tick_count: number;
}

// Upserted every tick. A restart (new pid/started_at) resets tick_count;
// the same process just bumps it and refreshes last_tick_at.
export function beatDaemonHeartbeat(
  db: Database,
  opts: { pid: number; startedAt: string; version?: string },
): void {
  db.prepare(
    `INSERT INTO cron_daemon_heartbeat (id, pid, started_at, last_tick_at, version, tick_count)
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
       END`,
  ).run({
    $pid: opts.pid,
    $started_at: opts.startedAt,
    $now: nowIso(),
    $version: opts.version ?? null,
  });
}

export function getDaemonHeartbeat(db: Database): DaemonHeartbeatRow | null {
  const row = db
    .query(
      `SELECT pid, started_at, last_tick_at, version, tick_count
       FROM cron_daemon_heartbeat WHERE id = 1`,
    )
    .get() as DaemonHeartbeatRow | undefined;
  return row ?? null;
}

// --- v2 daemon: reporting ---

export interface RunHistoryRow {
  id: number;
  slug: string;
  started_at: string;
  finished_at: string | null;
  status: InvocationStatus;
  trigger: InvocationTrigger;
  attempt: number;
  duration_ms: number | null;
  scheduled_for: string | null;
  exit_code: number | null;
  result_summary: string | null;
  log_path: string;
}

// The global (or per-slug) run timeline, newest first — backs the upcoming
// `cron history` CLI. Served by idx_inv_started / idx_inv_job_started.
export function listRunHistory(
  db: Database,
  opts: { slug?: string; limit?: number; sinceIso?: string } = {},
): RunHistoryRow[] {
  return db
    .query(
      `SELECT i.id, j.slug, i.started_at, i.finished_at, i.status, i.trigger,
              i.attempt, i.duration_ms, i.scheduled_for, i.exit_code,
              i.result_summary, i.log_path
       FROM cron_invocations i
       JOIN cron_jobs j ON j.id = i.job_id
       WHERE ($slug IS NULL OR j.slug = $slug)
         AND ($since IS NULL OR i.started_at >= $since)
       ORDER BY i.started_at DESC, i.id DESC
       LIMIT $limit`,
    )
    .all({
      $slug: opts.slug ?? null,
      $since: opts.sinceIso ?? null,
      $limit: opts.limit ?? 50,
    }) as RunHistoryRow[];
}

export interface JobStatsRow {
  slug: string;
  runs: number;
  ok: number;
  fail: number;
  timeout: number;
  success_rate: number | null; // ok / finished runs; null when nothing finished
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  last_run_at: string | null;
  last_status: string | null;
}

// Per-job health rollup over a window — backs the upcoming `cron stats` CLI.
// Aggregates run in SQL over duration_ms (never TEXT date math); p95 is
// nearest-rank over the sorted durations, computed here because SQLite has
// no percentile function.
export function jobStats(
  db: Database,
  opts: { sinceIso?: string } = {},
): JobStatsRow[] {
  const since = opts.sinceIso ?? null;
  const rows = db
    .query(
      `SELECT j.slug,
              COUNT(i.id) AS runs,
              COALESCE(SUM(i.status = 'ok'), 0) AS ok,
              COALESCE(SUM(i.status = 'fail'), 0) AS fail,
              COALESCE(SUM(i.status = 'timeout'), 0) AS timeout,
              COALESCE(SUM(i.finished_at IS NOT NULL), 0) AS finished,
              AVG(i.duration_ms) AS avg_duration_ms,
              COALESCE(j.last_run_at, MAX(i.started_at)) AS last_run_at,
              j.last_status
       FROM cron_jobs j
       JOIN cron_invocations i ON i.job_id = j.id
       WHERE ($since IS NULL OR i.started_at >= $since)
       GROUP BY j.id
       ORDER BY j.slug ASC`,
    )
    .all({ $since: since }) as (Omit<
    JobStatsRow,
    "success_rate" | "p95_duration_ms"
  > & { finished: number })[];

  const durations = db
    .query(
      `SELECT j.slug, i.duration_ms
       FROM cron_invocations i
       JOIN cron_jobs j ON j.id = i.job_id
       WHERE i.duration_ms IS NOT NULL
         AND ($since IS NULL OR i.started_at >= $since)
       ORDER BY j.slug ASC, i.duration_ms ASC`,
    )
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
      p95_duration_ms: p95,
    };
  });
}
