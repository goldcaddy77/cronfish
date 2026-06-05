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

export type InvocationStatus =
  | "running"
  | "ok"
  | "fail"
  | "timeout"
  | "crashed";
export type InvocationTrigger = "schedule" | "manual" | "retry";

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
];

export function migrate(db: Database): void {
  const current = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
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

export function upsertJob(db: Database, job: JobMeta): void {
  const stmt = db.prepare(`
    INSERT INTO cron_jobs (
      slug, kind, schedule, enabled, timeout_s, retries, concurrency,
      model, description, last_synced_at, deleted_at
    ) VALUES (
      $slug, $kind, $schedule, $enabled, $timeout_s, $retries, $concurrency,
      $model, $description, $now, NULL
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
      deleted_at = NULL
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
  });
}

export function markDeleted(db: Database, slugsPresent: string[]): void {
  const now = nowIso();
  if (slugsPresent.length === 0) {
    db.prepare(
      "UPDATE cron_jobs SET deleted_at = $now WHERE deleted_at IS NULL",
    ).run({
      $now: now,
    });
    return;
  }
  const placeholders = slugsPresent.map((_, i) => `$s${i}`).join(",");
  const params: Record<string, string> = { $now: now };
  slugsPresent.forEach((s, i) => (params[`$s${i}`] = s));
  db.prepare(
    `UPDATE cron_jobs SET deleted_at = $now WHERE deleted_at IS NULL AND slug NOT IN (${placeholders})`,
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
): number {
  const res = db
    .prepare(
      `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
       VALUES ($job_id, $now, 'running', $trigger, $log_path)`,
    )
    .run({
      $job_id: jobId,
      $now: nowIso(),
      $trigger: trigger,
      $log_path: logPath,
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
  db.prepare(
    `UPDATE cron_invocations
     SET finished_at = $now,
         status = $status,
         exit_code = $exit_code,
         result_summary = $result_summary,
         result_ok = $result_ok,
         result_json = $result_json,
         result_truncated = $result_truncated
     WHERE id = $id`,
  ).run({
    $id: invocationId,
    $now: nowIso(),
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
