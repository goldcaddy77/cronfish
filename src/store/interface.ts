// The cronfish storage seam.
//
// `CronStore` is the dialect-neutral, uniformly-ASYNC interface every backend
// implements (SqliteStore today; a PostgresStore later). It leaks ZERO
// bun:sqlite types so a second backend can implement it without touching this
// file. All row/enum types the DB layer speaks live here — the shapes are
// unchanged from the old db.ts so every call site keeps compiling.
//
// The store is SEMANTIC-RELATIONAL (scheduler operations), not a KV blob store:
// each method is a named scheduler operation, and the three multi-statement
// atomic operations (migrate, claimPendingRunRequests, pruneLedger) are single
// methods with the transaction as a private impl detail — never a generic
// `transaction(fn)` primitive (that would re-leak a driver object).

import type { JobMeta } from "../jobs.ts";
import type { ScheduleKind } from "../next-run.ts";
import type { SlugRetention } from "../prune.ts";

// --- Enums (dialect-neutral) ---

export type InvocationStatus =
  | "running"
  | "ok"
  | "fail"
  | "timeout"
  | "crashed";
// 'catchup' = the single coalesced post-downtime run (docs/v2-daemon.md).
export type InvocationTrigger = "schedule" | "manual" | "retry" | "catchup";
export type JobState = "active" | "disabled" | "deleted";
export type AlertLedgerStatus = "sent" | "skipped" | "error" | "recovered";

// --- Row shapes (unchanged from db.ts) ---

export interface InvocationResultRow {
  summary: string | null;
  ok: boolean | null;
  json: string | null;
  truncated: boolean;
}

export interface EnabledJobRow {
  id: number;
  slug: string;
  schedule: string;
}

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
  file_path: string | null;
}

export interface JobSyncStateRow {
  id: number;
  slug: string;
  state: JobState | null;
  schedule: string;
  schedule_kind: ScheduleKind | null;
  file_mtime: string | null;
  file_size: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface RunRequestRow {
  id: number;
  job_id: number;
  slug: string;
  trigger: "manual";
  requested_at: string;
  file_path: string | null;
}

export interface RunRequestStatusRow {
  picked_up_at: string | null;
  invocation_id: number | null;
  expired_at: string | null;
}

export interface DaemonHeartbeatRow {
  pid: number;
  started_at: string;
  last_tick_at: string;
  version: string | null;
  tick_count: number;
}

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

// A pending request this old at claim time is stale — the requester's
// `cron run` poll gave up long ago (daemon down / wedged in between). Firing
// it now would be a surprise run; mark it expired instead.
export const RUN_REQUEST_EXPIRY_MS = 5 * 60_000;

// --- UI / CLI read-view row shapes (pulled out of ui/server.ts + cli.ts) ---

// The base cron_jobs row shape the dashboard renders (ui/server.ts JobRow).
export interface JobRow {
  id: number;
  slug: string;
  kind: string;
  schedule: string;
  enabled: number;
  timeout_s: number | null;
  retries: number;
  concurrency: string;
  model: string | null;
  description: string | null;
  last_synced_at: string;
  deleted_at: string | null;
  // v2 daemon scheduler columns (NULL on a pre-v6 row until the next sync).
  state: string | null;
  schedule_kind: string | null;
  next_run_at: string | null;
}

// One cron_jobs row joined to its most-recent invocation — backs /api/jobs.
export interface JobWithLastInvocationRow extends JobRow {
  last_status: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  last_invocation_id: number | null;
}

// A cron_invocations row as the dashboard renders it (ui/server.ts).
export interface InvocationRow {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  exit_code: number | null;
  trigger: string;
  log_path: string;
  result_summary: string | null;
  result_ok: number | null;
  result_json: string | null;
  result_truncated: number;
}

export type InvocationWithDurationRow = InvocationRow & {
  duration_ms: number | null;
};

export type InvocationWithSlugRow = InvocationRow & {
  slug: string;
  duration_ms: number | null;
};

// The most-recent finished result per slug — backs cli `loadLastResults`.
export interface LastResultRow {
  slug: string;
  result_summary: string | null;
  finished_at: string | null;
}

// --- Ledger prune (the DB body moved into the store; fs sibling stays) ---

export interface LedgerPruneOptions {
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

// --- The store interface ---

export interface CronStore {
  // Lifecycle
  migrate(upTo?: number): Promise<void>;
  close(): Promise<void>;

  // Jobs
  upsertJob(
    job: JobMeta,
    fileMtimeIso?: string,
    fileSizeBytes?: number,
  ): Promise<void>;
  markDeleted(slugsPresent: string[]): Promise<void>;
  getJobIdBySlug(slug: string): Promise<number | null>;
  listEnabledJobs(): Promise<EnabledJobRow[]>;
  listDueJobs(nowIso: string): Promise<DueJobRow[]>;
  listJobSyncState(): Promise<JobSyncStateRow[]>;
  setJobNextRun(jobId: number, nextRunAtIso: string | null): Promise<void>;
  setJobLastRun(
    jobId: number,
    lastRunAtIso: string,
    lastStatus: InvocationStatus,
  ): Promise<void>;

  // Invocations
  startInvocation(
    jobId: number,
    trigger: InvocationTrigger,
    logPath: string,
    opts?: { attempt?: number; scheduledFor?: string },
  ): Promise<number>;
  finishInvocation(
    invocationId: number,
    status: InvocationStatus,
    exitCode: number | null,
    result?: InvocationResultRow,
    attempt?: number,
  ): Promise<void>;
  setInvocationAlert(
    invocationId: number,
    status: AlertLedgerStatus,
    error: string | null,
  ): Promise<void>;
  setInvocationLogPath(invocationId: number, logPath: string): Promise<void>;
  getInvocationLogPath(invocationId: number): Promise<string | null>;
  getLastOkStartedAt(jobId: number): Promise<string | null>;
  getPreviousFinishedStatus(
    jobId: number,
    excludingId: number,
  ): Promise<InvocationStatus | null>;

  // Run-requests
  insertRunRequest(jobId: number): Promise<number>;
  claimPendingRunRequests(nowIso?: string): Promise<RunRequestRow[]>;
  expireRunRequest(requestId: number): Promise<void>;
  clearRunRequestClaim(requestId: number): Promise<void>;
  linkRunRequestInvocation(
    requestId: number,
    invocationId: number,
  ): Promise<void>;
  getRunRequest(requestId: number): Promise<RunRequestStatusRow | null>;

  // Alerts (missed-run dedup)
  getLatestMissedFiredAt(jobId: number): Promise<string | null>;
  recordMissedAlert(jobId: number, expectedAtIso: string): Promise<number>;

  // Heartbeat
  beatDaemonHeartbeat(opts: {
    pid: number;
    startedAt: string;
    version?: string;
  }): Promise<void>;
  getDaemonHeartbeat(): Promise<DaemonHeartbeatRow | null>;

  // History / stats
  listRunHistory(opts?: {
    slug?: string;
    limit?: number;
    sinceIso?: string;
  }): Promise<RunHistoryRow[]>;
  jobStats(opts?: { sinceIso?: string }): Promise<JobStatsRow[]>;

  // UI / CLI read views
  listJobsWithLastInvocation(): Promise<JobWithLastInvocationRow[]>;
  getJobBySlug(slug: string): Promise<JobRow | null>;
  getLastInvocationStartedAt(slug: string): Promise<string | null>;
  listInvocationsForSlug(
    slug: string,
    limit: number,
  ): Promise<InvocationWithDurationRow[]>;
  listAllInvocations(limit: number): Promise<InvocationWithSlugRow[]>;
  getInvocationWithDuration(id: number): Promise<InvocationWithSlugRow | null>;
  getLastResults(): Promise<LastResultRow[]>;

  // Ledger prune (multi-DELETE transaction is a private impl detail)
  pruneLedger(opts: LedgerPruneOptions): Promise<LedgerPruneReport>;
}
