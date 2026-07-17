import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  beatDaemonHeartbeat,
  claimPendingRunRequests,
  finishInvocation,
  getDaemonHeartbeat,
  getJobIdBySlug,
  insertRunRequest,
  jobStats,
  linkRunRequestInvocation,
  listDueJobs,
  listRunHistory,
  markDeleted,
  migrate,
  setJobLastRun,
  setJobNextRun,
  startInvocation,
  upsertJob,
} from "../src/db.ts";
import type { JobMeta } from "../src/jobs.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function meta(overrides: Partial<JobMeta> & { slug: string }): JobMeta {
  return {
    path: `/cron/${overrides.slug}.md`,
    kind: "md",
    enabled: true,
    schedule: "5m",
    ...overrides,
  };
}

function tableNames(db: Database): string[] {
  return (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columnNames(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}

// Seed a finished invocation with an explicit duration — raw SQL so stats
// tests exercise the reporting queries against known numbers.
function seedInvocation(
  db: Database,
  jobId: number,
  opts: {
    startedAt: string;
    status: string;
    durationMs?: number | null;
    trigger?: string;
  },
): void {
  db.prepare(
    `INSERT INTO cron_invocations
       (job_id, started_at, finished_at, status, trigger, log_path, duration_ms)
     VALUES ($job_id, $started_at, $finished_at, $status, $trigger, '/tmp/x.log', $duration_ms)`,
  ).run({
    $job_id: jobId,
    $started_at: opts.startedAt,
    $finished_at: opts.status === "running" ? null : opts.startedAt,
    $status: opts.status,
    $trigger: opts.trigger ?? "schedule",
    $duration_ms: opts.durationMs ?? null,
  });
}

describe("migration ladder", () => {
  test("fresh db lands on v6 with the daemon tables and columns", () => {
    const db = freshDb();
    expect(userVersion(db)).toBe(6);

    const tables = tableNames(db);
    expect(tables).toContain("cron_run_requests");
    expect(tables).toContain("cron_daemon_heartbeat");

    const jobCols = columnNames(db, "cron_jobs");
    for (const c of [
      "state",
      "next_run_at",
      "last_run_at",
      "last_status",
      "file_path",
      "file_mtime",
      "schedule_kind",
    ]) {
      expect(jobCols).toContain(c);
    }

    const invCols = columnNames(db, "cron_invocations");
    for (const c of ["duration_ms", "attempt", "scheduled_for"]) {
      expect(invCols).toContain(c);
    }
  });

  test("v5 db upgrades in place: state/schedule_kind/duration backfilled, history preserved", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, 5);
    expect(userVersion(db)).toBe(5);

    // Legacy rows written by the v1-era schema — no state, no duration_ms.
    db.exec(`
      INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at)
        VALUES ('alive-md', 'md', '5m', 1, '2026-01-01T00:00:00.000Z');
      INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at)
        VALUES ('daily-md', 'md', '0 9 * * *', 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at, deleted_at)
        VALUES ('gone-md', 'md', 'manual', 1, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      INSERT INTO cron_invocations (job_id, started_at, finished_at, status, exit_code, trigger, log_path, result_summary)
        VALUES (1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.500Z', 'ok', 0, 'schedule', '/tmp/a.log', 'did the thing');
      INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
        VALUES (1, '2026-01-01T01:00:00.000Z', 'running', 'manual', '/tmp/b.log');
    `);

    migrate(db);
    expect(userVersion(db)).toBe(6);

    const jobs = db
      .query(
        "SELECT slug, state, schedule_kind FROM cron_jobs ORDER BY slug",
      )
      .all() as { slug: string; state: string; schedule_kind: string }[];
    expect(jobs).toEqual([
      { slug: "alive-md", state: "active", schedule_kind: "interval" },
      { slug: "daily-md", state: "disabled", schedule_kind: "cron" },
      { slug: "gone-md", state: "deleted", schedule_kind: "manual" },
    ]);

    // History survived the table rebuild; the finished row got a duration.
    const invs = db
      .query(
        "SELECT status, duration_ms, attempt, result_summary FROM cron_invocations ORDER BY id",
      )
      .all() as {
      status: string;
      duration_ms: number | null;
      attempt: number;
      result_summary: string | null;
    }[];
    expect(invs).toEqual([
      { status: "ok", duration_ms: 2500, attempt: 1, result_summary: "did the thing" },
      { status: "running", duration_ms: null, attempt: 1, result_summary: null },
    ]);

    // The widened trigger domain accepts the coalesced catch-up run.
    seedInvocation(db, 1, {
      startedAt: "2026-01-01T02:00:00.000Z",
      status: "ok",
      trigger: "catchup",
    });
    expect(() =>
      seedInvocation(db, 1, {
        startedAt: "2026-01-01T03:00:00.000Z",
        status: "ok",
        trigger: "bogus",
      }),
    ).toThrow();
  });
});

describe("job scheduler state", () => {
  test("upsertJob writes state, schedule_kind, and file metadata", () => {
    const db = freshDb();
    upsertJob(db, meta({ slug: "a-md" }), "2026-07-17T00:00:00.000Z");
    const row = db
      .query(
        "SELECT state, schedule_kind, file_path, file_mtime FROM cron_jobs WHERE slug = 'a-md'",
      )
      .get() as Record<string, string>;
    expect(row).toEqual({
      state: "active",
      schedule_kind: "interval",
      file_path: "/cron/a-md.md",
      file_mtime: "2026-07-17T00:00:00.000Z",
    });

    // Re-sync without an mtime keeps the stored one; disabling flips state.
    upsertJob(db, meta({ slug: "a-md", enabled: false }));
    const row2 = db
      .query("SELECT state, file_mtime FROM cron_jobs WHERE slug = 'a-md'")
      .get() as Record<string, string>;
    expect(row2).toEqual({
      state: "disabled",
      file_mtime: "2026-07-17T00:00:00.000Z",
    });
  });

  test("markDeleted flips state to deleted; rows are kept for history", () => {
    const db = freshDb();
    upsertJob(db, meta({ slug: "keep-md" }));
    upsertJob(db, meta({ slug: "drop-md" }));
    markDeleted(db, ["keep-md"]);
    const states = db
      .query("SELECT slug, state FROM cron_jobs ORDER BY slug")
      .all();
    expect(states).toEqual([
      { slug: "drop-md", state: "deleted" },
      { slug: "keep-md", state: "active" },
    ]);
  });

  test("listDueJobs returns only active jobs whose next_run_at has arrived", () => {
    const db = freshDb();
    for (const slug of ["due-md", "future-md", "off-md", "manual-md"]) {
      upsertJob(db, meta({ slug, enabled: slug !== "off-md" }));
    }
    const id = (slug: string) => getJobIdBySlug(db, slug)!;
    setJobNextRun(db, id("due-md"), "2026-07-17T11:00:00.000Z");
    setJobNextRun(db, id("future-md"), "2026-07-17T13:00:00.000Z");
    setJobNextRun(db, id("off-md"), "2026-07-17T11:00:00.000Z");
    // manual-md keeps next_run_at NULL — never due.

    const due = listDueJobs(db, "2026-07-17T12:00:00.000Z");
    expect(due.map((j) => j.slug)).toEqual(["due-md"]);
    expect(due[0].next_run_at).toBe("2026-07-17T11:00:00.000Z");
  });

  test("setJobLastRun records the job's latest outcome", () => {
    const db = freshDb();
    upsertJob(db, meta({ slug: "a-md" }));
    setJobLastRun(db, getJobIdBySlug(db, "a-md")!, "2026-07-17T12:00:00.000Z", "ok");
    const row = db
      .query("SELECT last_run_at, last_status FROM cron_jobs WHERE slug = 'a-md'")
      .get();
    expect(row).toEqual({
      last_run_at: "2026-07-17T12:00:00.000Z",
      last_status: "ok",
    });
  });
});

describe("run requests", () => {
  test("insert → claim marks pickup; a second claim drains nothing", () => {
    const db = freshDb();
    upsertJob(db, meta({ slug: "a-md" }));
    upsertJob(db, meta({ slug: "b-md" }));
    const aId = getJobIdBySlug(db, "a-md")!;
    insertRunRequest(db, aId);
    insertRunRequest(db, getJobIdBySlug(db, "b-md")!);

    const claimed = claimPendingRunRequests(db);
    expect(claimed.map((r) => r.slug)).toEqual(["a-md", "b-md"]);
    expect(claimPendingRunRequests(db)).toEqual([]);

    // Claimed rows carry picked_up_at; linking ties them to the invocation.
    const invId = startInvocation(db, aId, "manual", "/tmp/a.log");
    linkRunRequestInvocation(db, claimed[0].id, invId);
    const row = db
      .query(
        "SELECT picked_up_at, invocation_id FROM cron_run_requests WHERE id = $id",
      )
      .get({ $id: claimed[0].id }) as {
      picked_up_at: string | null;
      invocation_id: number | null;
    };
    expect(row.picked_up_at).not.toBeNull();
    expect(row.invocation_id).toBe(invId);
  });
});

describe("daemon heartbeat", () => {
  test("same process increments tick_count; a restart resets it", () => {
    const db = freshDb();
    const boot = { pid: 100, startedAt: "2026-07-17T00:00:00.000Z", version: "0.15.0" };
    beatDaemonHeartbeat(db, boot);
    beatDaemonHeartbeat(db, boot);
    let hb = getDaemonHeartbeat(db)!;
    expect(hb.pid).toBe(100);
    expect(hb.tick_count).toBe(2);
    expect(hb.version).toBe("0.15.0");

    beatDaemonHeartbeat(db, { pid: 200, startedAt: "2026-07-17T01:00:00.000Z" });
    hb = getDaemonHeartbeat(db)!;
    expect(hb.pid).toBe(200);
    expect(hb.tick_count).toBe(1);
  });

  test("no heartbeat yet reads as null", () => {
    expect(getDaemonHeartbeat(freshDb())).toBeNull();
  });
});

describe("invocation reporting columns", () => {
  test("startInvocation stores attempt and scheduled_for; finish writes duration_ms", () => {
    const db = freshDb();
    upsertJob(db, meta({ slug: "a-md" }));
    const jobId = getJobIdBySlug(db, "a-md")!;
    const invId = startInvocation(db, jobId, "retry", "/tmp/a.log", {
      attempt: 2,
      scheduledFor: "2026-07-17T12:00:00.000Z",
    });
    finishInvocation(db, invId, "ok", 0);
    const row = db
      .query(
        "SELECT attempt, scheduled_for, duration_ms FROM cron_invocations WHERE id = $id",
      )
      .get({ $id: invId }) as {
      attempt: number;
      scheduled_for: string;
      duration_ms: number;
    };
    expect(row.attempt).toBe(2);
    expect(row.scheduled_for).toBe("2026-07-17T12:00:00.000Z");
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("reporting queries", () => {
  function seedHistory(db: Database): void {
    upsertJob(db, meta({ slug: "a-md" }));
    upsertJob(db, meta({ slug: "b-md" }));
    const a = getJobIdBySlug(db, "a-md")!;
    const b = getJobIdBySlug(db, "b-md")!;
    seedInvocation(db, a, { startedAt: "2026-07-15T00:00:00.000Z", status: "ok", durationMs: 100 });
    seedInvocation(db, a, { startedAt: "2026-07-16T00:00:00.000Z", status: "ok", durationMs: 200 });
    seedInvocation(db, a, { startedAt: "2026-07-17T00:00:00.000Z", status: "fail", durationMs: 300 });
    seedInvocation(db, b, { startedAt: "2026-07-17T06:00:00.000Z", status: "timeout", durationMs: 5000 });
    setJobLastRun(db, a, "2026-07-17T00:00:00.000Z", "fail");
    setJobLastRun(db, b, "2026-07-17T06:00:00.000Z", "timeout");
  }

  test("listRunHistory: newest first, slug/since/limit filters", () => {
    const db = freshDb();
    seedHistory(db);

    const all = listRunHistory(db, {});
    expect(all.map((r) => r.slug)).toEqual(["b-md", "a-md", "a-md", "a-md"]);
    expect(all[0].duration_ms).toBe(5000);

    const aOnly = listRunHistory(db, { slug: "a-md", limit: 2 });
    expect(aOnly.map((r) => r.started_at)).toEqual([
      "2026-07-17T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    ]);

    const recent = listRunHistory(db, { sinceIso: "2026-07-17T00:00:00.000Z" });
    expect(recent.map((r) => r.slug)).toEqual(["b-md", "a-md"]);
  });

  test("jobStats: counts, success_rate, avg and p95 durations", () => {
    const db = freshDb();
    seedHistory(db);

    const stats = jobStats(db);
    expect(stats.map((s) => s.slug)).toEqual(["a-md", "b-md"]);

    const a = stats[0];
    expect(a.runs).toBe(3);
    expect(a.ok).toBe(2);
    expect(a.fail).toBe(1);
    expect(a.timeout).toBe(0);
    expect(a.success_rate).toBeCloseTo(2 / 3);
    expect(a.avg_duration_ms).toBe(200);
    expect(a.p95_duration_ms).toBe(300); // nearest-rank over [100, 200, 300]
    expect(a.last_run_at).toBe("2026-07-17T00:00:00.000Z");
    expect(a.last_status).toBe("fail");

    const b = stats[1];
    expect(b.runs).toBe(1);
    expect(b.timeout).toBe(1);
    expect(b.success_rate).toBe(0);
    expect(b.p95_duration_ms).toBe(5000);
  });

  test("jobStats honors the since window", () => {
    const db = freshDb();
    seedHistory(db);
    const stats = jobStats(db, { sinceIso: "2026-07-17T00:00:00.000Z" });
    const a = stats.find((s) => s.slug === "a-md")!;
    expect(a.runs).toBe(1);
    expect(a.ok).toBe(0);
    expect(a.success_rate).toBe(0);
  });
});
