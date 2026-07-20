import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  openStore,
  RUN_REQUEST_EXPIRY_MS,
  SqliteStore,
  type CronStore,
} from "../src/store/index.ts";
import type { JobMeta } from "../src/jobs.ts";
import { BACKENDS, type StoreKit } from "./support/store-harness.ts";

function meta(overrides: Partial<JobMeta> & { slug: string }): JobMeta {
  return {
    path: `/cron/${overrides.slug}.md`,
    kind: "md",
    enabled: true,
    schedule: "5m",
    ...overrides,
  };
}

// --- SQLite-specific: migration ladder + open-time PRAGMAs ---
//
// These assert SQLite user_version / ALTER mechanics and the exact open PRAGMA
// set, so they stay bound to the SQLite backend and do NOT run under
// describe.each. `migrate(db, upTo?)` is now SqliteStore.migrate — a fresh
// SqliteStore over a raw in-memory handle drives the ladder.

// Build a raw in-memory db migrated to an optional older rung, plus a handle to
// re-run migrations. Mirrors the old freshDb()/migrate(db, upTo) helper pair.
async function migratedTo(upTo?: number): Promise<Database> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  await new SqliteStore(db).migrate(upTo);
  return db;
}

async function migrate(db: Database, upTo?: number): Promise<void> {
  await new SqliteStore(db).migrate(upTo);
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

describe("migration ladder [sqlite]", () => {
  test("fresh db lands on v6 with the daemon tables and columns", async () => {
    const db = await migratedTo();
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

  test("v5 db upgrades in place: state/schedule_kind/duration backfilled, history preserved", async () => {
    const db = await migratedTo(5);
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

    await migrate(db);
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

  test("v6 backfills last_run_at from run history (else the hot swap fires every interval job at once)", async () => {
    const db = await migratedTo(5);

    db.exec(`
      INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at)
        VALUES ('hourly-md', 'md', '1h', 1, '2026-01-01T00:00:00.000Z');
      INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at)
        VALUES ('never-ran-md', 'md', '1h', 1, '2026-01-01T00:00:00.000Z');
      INSERT INTO cron_invocations (job_id, started_at, finished_at, status, exit_code, trigger, log_path)
        VALUES (1, '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:01.000Z', 'ok', 0, 'schedule', '/tmp/a.log');
      INSERT INTO cron_invocations (job_id, started_at, finished_at, status, exit_code, trigger, log_path)
        VALUES (1, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:01.000Z', 'ok', 0, 'schedule', '/tmp/b.log');
    `);

    await migrate(db);
    const rows = db
      .query("SELECT slug, last_run_at FROM cron_jobs ORDER BY slug")
      .all() as { slug: string; last_run_at: string | null }[];
    expect(rows).toEqual([
      { slug: "hourly-md", last_run_at: "2026-01-01T10:00:00.000Z" },
      { slug: "never-ran-md", last_run_at: null },
    ]);
  });
});

describe("openStore pragmas [sqlite]", () => {
  test("sets busy_timeout so concurrent writers retry instead of failing instantly", async () => {
    const root = mkdtempSync(join(tmpdir(), "cronfish-db-"));
    try {
      const store = await openStore(root);
      const row = store.rawHandleForTests().query("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      expect(row.timeout).toBe(5000);
      await store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Dialect-neutral behavioral suite: runs against every backend ---

describe.each(BACKENDS)("cron store behavior [%s]", (_name, factory) => {
  let store: CronStore;
  let kit: StoreKit;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    const built = await factory();
    store = built.store;
    kit = built.kit;
    dispose = built.dispose;
  });

  afterEach(async () => {
    await dispose();
  });

  describe("job scheduler state", () => {
    test("upsertJob writes state, schedule_kind, and file metadata", async () => {
      await store.upsertJob(meta({ slug: "a-md" }), "2026-07-17T00:00:00.000Z");
      const row = await kit.jobFields("a-md", [
        "state",
        "schedule_kind",
        "file_path",
        "file_mtime",
      ]);
      expect(row).toEqual({
        state: "active",
        schedule_kind: "interval",
        file_path: "/cron/a-md.md",
        file_mtime: "2026-07-17T00:00:00.000Z",
      });

      // Re-sync without an mtime keeps the stored one; disabling flips state.
      await store.upsertJob(meta({ slug: "a-md", enabled: false }));
      const row2 = await kit.jobFields("a-md", ["state", "file_mtime"]);
      expect(row2).toEqual({
        state: "disabled",
        file_mtime: "2026-07-17T00:00:00.000Z",
      });
    });

    test("markDeleted flips state to deleted; rows are kept for history", async () => {
      await store.upsertJob(meta({ slug: "keep-md" }));
      await store.upsertJob(meta({ slug: "drop-md" }));
      await store.markDeleted(["keep-md"]);
      const states = await kit.listJobStates();
      expect(states).toEqual([
        { slug: "drop-md", state: "deleted" },
        { slug: "keep-md", state: "active" },
      ]);
    });

    test("listDueJobs returns only active jobs whose next_run_at has arrived", async () => {
      for (const slug of ["due-md", "future-md", "off-md", "manual-md"]) {
        await store.upsertJob(meta({ slug, enabled: slug !== "off-md" }));
      }
      const id = async (slug: string) => (await store.getJobIdBySlug(slug))!;
      await store.setJobNextRun(await id("due-md"), "2026-07-17T11:00:00.000Z");
      await store.setJobNextRun(await id("future-md"), "2026-07-17T13:00:00.000Z");
      await store.setJobNextRun(await id("off-md"), "2026-07-17T11:00:00.000Z");
      // manual-md keeps next_run_at NULL — never due.

      const due = await store.listDueJobs("2026-07-17T12:00:00.000Z");
      expect(due.map((j) => j.slug)).toEqual(["due-md"]);
      expect(due[0].next_run_at).toBe("2026-07-17T11:00:00.000Z");
    });

    test("setJobLastRun records the job's latest outcome", async () => {
      await store.upsertJob(meta({ slug: "a-md" }));
      await store.setJobLastRun(
        (await store.getJobIdBySlug("a-md"))!,
        "2026-07-17T12:00:00.000Z",
        "ok",
      );
      const row = await kit.jobFields("a-md", ["last_run_at", "last_status"]);
      expect(row).toEqual({
        last_run_at: "2026-07-17T12:00:00.000Z",
        last_status: "ok",
      });
    });
  });

  describe("run requests", () => {
    test("insert → claim marks pickup; a second claim drains nothing", async () => {
      await store.upsertJob(meta({ slug: "a-md" }));
      await store.upsertJob(meta({ slug: "b-md" }));
      const aId = (await store.getJobIdBySlug("a-md"))!;
      await store.insertRunRequest(aId);
      await store.insertRunRequest((await store.getJobIdBySlug("b-md"))!);

      const claimed = await store.claimPendingRunRequests();
      expect(claimed.map((r) => r.slug)).toEqual(["a-md", "b-md"]);
      expect(await store.claimPendingRunRequests()).toEqual([]);

      // Claimed rows carry picked_up_at; linking ties them to the invocation.
      const invId = await store.startInvocation(aId, "manual", "/tmp/a.log");
      await store.linkRunRequestInvocation(claimed[0].id, invId);
      const row = (await kit.runRequestFields(claimed[0].id, [
        "picked_up_at",
        "invocation_id",
      ]))!;
      expect(row.picked_up_at).not.toBeNull();
      expect(row.invocation_id).toBe(invId);
    });

    test("requests older than the expiry window are stamped expired and never claimed", async () => {
      await store.upsertJob(meta({ slug: "a-md" }));
      const jobId = (await store.getJobIdBySlug("a-md"))!;
      const reqId = await store.insertRunRequest(jobId);
      // Age the request past the window.
      const old = new Date(
        Date.now() - RUN_REQUEST_EXPIRY_MS - 60_000,
      ).toISOString();
      await kit.ageRunRequest(reqId, old);

      expect(await store.claimPendingRunRequests()).toEqual([]);
      const row = (await kit.runRequestFields(reqId, [
        "picked_up_at",
        "expired_at",
      ]))!;
      expect(row.picked_up_at).toBeNull();
      expect(row.expired_at).not.toBeNull();
      // Stays expired — later claims never resurrect it.
      expect(await store.claimPendingRunRequests()).toEqual([]);
    });

    test("clearRunRequestClaim releases an unlinked claim for retry, never a linked one", async () => {
      await store.upsertJob(meta({ slug: "a-md" }));
      const jobId = (await store.getJobIdBySlug("a-md"))!;
      const reqId = await store.insertRunRequest(jobId);

      // Claim, then release (the spawn-failure path) → claimable again.
      expect(await store.claimPendingRunRequests()).toHaveLength(1);
      await store.clearRunRequestClaim(reqId);
      expect((await store.getRunRequest(reqId))!.picked_up_at).toBeNull();
      const reclaimed = await store.claimPendingRunRequests();
      expect(reclaimed.map((r) => r.id)).toEqual([reqId]);

      // Linked to an invocation → the claim is final.
      const invId = await store.startInvocation(jobId, "manual", "/tmp/a.log");
      await store.linkRunRequestInvocation(reqId, invId);
      await store.clearRunRequestClaim(reqId);
      expect((await store.getRunRequest(reqId))!.picked_up_at).not.toBeNull();
    });
  });

  describe("daemon heartbeat", () => {
    test("same process increments tick_count; a restart resets it", async () => {
      const boot = { pid: 100, startedAt: "2026-07-17T00:00:00.000Z", version: "0.15.0" };
      await store.beatDaemonHeartbeat(boot);
      await store.beatDaemonHeartbeat(boot);
      let hb = (await store.getDaemonHeartbeat())!;
      expect(hb.pid).toBe(100);
      expect(hb.tick_count).toBe(2);
      expect(hb.version).toBe("0.15.0");

      await store.beatDaemonHeartbeat({ pid: 200, startedAt: "2026-07-17T01:00:00.000Z" });
      hb = (await store.getDaemonHeartbeat())!;
      expect(hb.pid).toBe(200);
      expect(hb.tick_count).toBe(1);
    });

    test("no heartbeat yet reads as null", async () => {
      expect(await store.getDaemonHeartbeat()).toBeNull();
    });
  });

  describe("invocation reporting columns", () => {
    test("startInvocation stores attempt and scheduled_for; finish writes duration_ms", async () => {
      await store.upsertJob(meta({ slug: "a-md" }));
      const jobId = (await store.getJobIdBySlug("a-md"))!;
      const invId = await store.startInvocation(jobId, "retry", "/tmp/a.log", {
        attempt: 2,
        scheduledFor: "2026-07-17T12:00:00.000Z",
      });
      await store.finishInvocation(invId, "ok", 0);
      const row = (await kit.invocationFields(invId, [
        "attempt",
        "scheduled_for",
        "duration_ms",
      ]))! as {
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
    async function seedHistory(): Promise<void> {
      await store.upsertJob(meta({ slug: "a-md" }));
      await store.upsertJob(meta({ slug: "b-md" }));
      const a = (await store.getJobIdBySlug("a-md"))!;
      const b = (await store.getJobIdBySlug("b-md"))!;
      await kit.seedInvocation(a, { startedAt: "2026-07-15T00:00:00.000Z", status: "ok", durationMs: 100 });
      await kit.seedInvocation(a, { startedAt: "2026-07-16T00:00:00.000Z", status: "ok", durationMs: 200 });
      await kit.seedInvocation(a, { startedAt: "2026-07-17T00:00:00.000Z", status: "fail", durationMs: 300 });
      await kit.seedInvocation(b, { startedAt: "2026-07-17T06:00:00.000Z", status: "timeout", durationMs: 5000 });
      await store.setJobLastRun(a, "2026-07-17T00:00:00.000Z", "fail");
      await store.setJobLastRun(b, "2026-07-17T06:00:00.000Z", "timeout");
    }

    test("listRunHistory: newest first, slug/since/limit filters", async () => {
      await seedHistory();

      const all = await store.listRunHistory({});
      expect(all.map((r) => r.slug)).toEqual(["b-md", "a-md", "a-md", "a-md"]);
      expect(all[0].duration_ms).toBe(5000);

      const aOnly = await store.listRunHistory({ slug: "a-md", limit: 2 });
      expect(aOnly.map((r) => r.started_at)).toEqual([
        "2026-07-17T00:00:00.000Z",
        "2026-07-16T00:00:00.000Z",
      ]);

      const recent = await store.listRunHistory({ sinceIso: "2026-07-17T00:00:00.000Z" });
      expect(recent.map((r) => r.slug)).toEqual(["b-md", "a-md"]);
    });

    test("jobStats: counts, success_rate, avg and p95 durations", async () => {
      await seedHistory();

      const stats = await store.jobStats();
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

    test("jobStats honors the since window", async () => {
      await seedHistory();
      const stats = await store.jobStats({ sinceIso: "2026-07-17T00:00:00.000Z" });
      const a = stats.find((s) => s.slug === "a-md")!;
      expect(a.runs).toBe(1);
      expect(a.ok).toBe(0);
      expect(a.success_rate).toBe(0);
    });

    test("jobStats shows a zero-run job (the silently-dead kind) instead of hiding it", async () => {
      await seedHistory();
      await store.upsertJob(meta({ slug: "dead-md" }));

      const stats = await store.jobStats();
      const dead = stats.find((s) => s.slug === "dead-md")!;
      expect(dead).toBeDefined();
      expect(dead.runs).toBe(0);
      expect(dead.ok).toBe(0);
      expect(dead.success_rate).toBeNull();
      expect(dead.avg_duration_ms).toBeNull();
      expect(dead.p95_duration_ms).toBeNull();
      expect(dead.last_run_at).toBeNull();

      // The since window must not resurrect INNER JOIN semantics: a job whose
      // runs all predate the window still shows runs=0.
      const windowed = await store.jobStats({ sinceIso: "2027-01-01T00:00:00.000Z" });
      const a = windowed.find((s) => s.slug === "a-md")!;
      expect(a.runs).toBe(0);

      // Deleted jobs stay out of the health rollup.
      await store.markDeleted(["a-md", "b-md"]); // dead-md gone from disk
      expect((await store.jobStats()).map((s) => s.slug)).toEqual(["a-md", "b-md"]);
    });
  });
});
