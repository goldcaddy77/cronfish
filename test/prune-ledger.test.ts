import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { RUNNING_PROTECT_MS } from "../src/prune.ts";
import type { CronStore } from "../src/store/index.ts";
import { BACKENDS } from "./support/store-harness.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function iso(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

// pruneLedger is a dialect-neutral scheduler operation, so it runs against
// every backend. Seeding/asserting is dialect SQL via the raw handle — the
// SQLite backend provides one; a future PostgresStore factory would provide its
// own raw handle (or seed via store methods).
describe.each(BACKENDS)("pruneLedger [%s]", (_name, factory) => {
  let store: CronStore;
  let db: Database;
  let dispose: () => Promise<void>;

  function addJob(slug: string, state = "active"): number {
    const res = db
      .prepare(
        `INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at, state)
         VALUES ($slug, 'md', 'every 30 seconds', 1, $now, $state)`,
      )
      .run({ $slug: slug, $now: iso(0), $state: state });
    return Number(res.lastInsertRowid);
  }

  function addInvocation(jobId: number, ageDays: number, status = "ok"): number {
    const res = db
      .prepare(
        `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
         VALUES ($job, $started, $status, 'schedule', '/tmp/x.log')`,
      )
      .run({ $job: jobId, $started: iso(ageDays * DAY), $status: status });
    return Number(res.lastInsertRowid);
  }

  function addRunRequest(jobId: number, ageDays: number, invId?: number): number {
    const res = db
      .prepare(
        `INSERT INTO cron_run_requests (job_id, trigger, requested_at, invocation_id)
         VALUES ($job, 'manual', $at, $inv)`,
      )
      .run({ $job: jobId, $at: iso(ageDays * DAY), $inv: invId ?? null });
    return Number(res.lastInsertRowid);
  }

  function addMissedAlert(jobId: number, ageDays: number): void {
    db.prepare(
      `INSERT INTO cron_missed_alerts (job_id, expected_at, fired_at)
       VALUES ($job, $at, $at)`,
    ).run({ $job: jobId, $at: iso(ageDays * DAY) });
  }

  function count(table: string): number {
    return (
      db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }

  beforeEach(async () => {
    const built = await factory();
    store = built.store;
    db = built.raw!;
    dispose = built.dispose;
  });

  afterEach(async () => {
    await dispose();
  });

  test("deletes rows older than the window across all three tables", async () => {
    const job = addJob("foo-md");
    addInvocation(job, 40);
    addInvocation(job, 20);
    addRunRequest(job, 40);
    addRunRequest(job, 1);
    addMissedAlert(job, 40);
    addMissedAlert(job, 2);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      nowMs: NOW,
    });

    expect(report).toEqual({ invocations: 1, runRequests: 1, missedAlerts: 1 });
    expect(count("cron_invocations")).toBe(1);
    expect(count("cron_run_requests")).toBe(1);
    expect(count("cron_missed_alerts")).toBe(1);
  });

  test("per-slug override replaces the global window for that slug", async () => {
    const noisy = addJob("noisy-md");
    const quiet = addJob("quiet-md");
    addInvocation(noisy, 10);
    addInvocation(quiet, 10);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 }, // would keep both
      perSlug: { "noisy-md": { maxAgeDays: 7 } },
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    const slugs = db
      .query(
        `SELECT j.slug FROM cron_invocations i JOIN cron_jobs j ON j.id = i.job_id`,
      )
      .all() as { slug: string }[];
    expect(slugs.map((s) => s.slug)).toEqual(["quiet-md"]);
  });

  test("a slug whose retention has no maxAgeDays is skipped (maxRuns is log-only)", async () => {
    const job = addJob("foo-md");
    addInvocation(job, 999);
    const report = await store.pruneLedger({ global: { maxRuns: 1 }, nowMs: NOW });
    expect(report.invocations).toBe(0);
    expect(count("cron_invocations")).toBe(1);
  });

  test("running rows newer than 24h are never deleted; older running debris prunes", async () => {
    const job = addJob("foo-md");
    // Zero-day window puts the cutoff at NOW — everything is "old", so only
    // the running-protection guard decides what survives.
    const freshRunning = addInvocation(job, 2 / 24, "running"); // 2h old
    addInvocation(job, 30 / 24, "running"); // 30h old — stale debris
    addInvocation(job, 1 / 24, "ok");

    const report = await store.pruneLedger({ global: { maxAgeDays: 0 }, nowMs: NOW });

    expect(report.invocations).toBe(2);
    const left = db.query("SELECT id FROM cron_invocations").all() as {
      id: number;
    }[];
    expect(left.map((r) => r.id)).toEqual([freshRunning]);
    expect(RUNNING_PROTECT_MS).toBe(DAY);
  });

  test("cron_jobs rows are never deleted, even for deleted jobs", async () => {
    const job = addJob("gone-md", "deleted");
    addInvocation(job, 100);
    await store.pruneLedger({ global: { maxAgeDays: 30 }, nowMs: NOW });
    expect(count("cron_invocations")).toBe(0);
    expect(count("cron_jobs")).toBe(1);
  });

  test("a surviving run request's link to a doomed invocation is severed, not a FK error", async () => {
    const job = addJob("foo-md");
    const oldInv = addInvocation(job, 40);
    const reqId = addRunRequest(job, 1, oldInv); // fresh request, old invocation

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    expect(report.runRequests).toBe(0);
    const req = db
      .query("SELECT invocation_id FROM cron_run_requests WHERE id = $id")
      .get({ $id: reqId }) as { invocation_id: number | null };
    expect(req.invocation_id).toBeNull();
  });

  test("onlySlug scopes row pruning to a single slug", async () => {
    const a = addJob("a-md");
    const b = addJob("b-md");
    addInvocation(a, 40);
    addInvocation(b, 40);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      onlySlug: "a-md",
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    expect(count("cron_invocations")).toBe(1);
  });

  test("dry-run reports counts but deletes nothing", async () => {
    const job = addJob("foo-md");
    addInvocation(job, 40);
    addRunRequest(job, 40);
    addMissedAlert(job, 40);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      dryRun: true,
      nowMs: NOW,
    });

    expect(report).toEqual({ invocations: 1, runRequests: 1, missedAlerts: 1 });
    expect(count("cron_invocations")).toBe(1);
    expect(count("cron_run_requests")).toBe(1);
    expect(count("cron_missed_alerts")).toBe(1);
  });
});
