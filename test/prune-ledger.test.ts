import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { RUNNING_PROTECT_MS } from "../src/prune.ts";
import type { CronStore } from "../src/store/index.ts";
import { BACKENDS, type StoreKit } from "./support/store-harness.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-17T12:00:00.000Z");

function iso(ageMs: number): string {
  return new Date(NOW - ageMs).toISOString();
}

// pruneLedger is a dialect-neutral scheduler operation, so it runs against
// every backend. Seeding/asserting goes through the harness `kit`, which
// implements the seed helpers per dialect — no test speaks a single backend's
// SQL directly.
describe.each(BACKENDS)("pruneLedger [%s]", (_name, factory) => {
  let store: CronStore;
  let kit: StoreKit;
  let dispose: () => Promise<void>;

  const addJob = (slug: string, state = "active"): Promise<number> =>
    kit.addJob(slug, state, iso(0));
  const addInvocation = (
    jobId: number,
    ageDays: number,
    status = "ok",
  ): Promise<number> => kit.addInvocation(jobId, iso(ageDays * DAY), status);
  const addRunRequest = (
    jobId: number,
    ageDays: number,
    invId?: number,
  ): Promise<number> =>
    kit.addRunRequest(jobId, iso(ageDays * DAY), invId ?? null);
  const addMissedAlert = (jobId: number, ageDays: number): Promise<void> =>
    kit.addMissedAlert(jobId, iso(ageDays * DAY));
  const count = (table: Parameters<StoreKit["count"]>[0]): Promise<number> =>
    kit.count(table);

  beforeEach(async () => {
    const built = await factory();
    store = built.store;
    kit = built.kit;
    dispose = built.dispose;
  });

  afterEach(async () => {
    await dispose();
  });

  test("deletes rows older than the window across all three tables", async () => {
    const job = await addJob("foo-md");
    await addInvocation(job, 40);
    await addInvocation(job, 20);
    await addRunRequest(job, 40);
    await addRunRequest(job, 1);
    await addMissedAlert(job, 40);
    await addMissedAlert(job, 2);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      nowMs: NOW,
    });

    expect(report).toEqual({ invocations: 1, runRequests: 1, missedAlerts: 1 });
    expect(await count("cron_invocations")).toBe(1);
    expect(await count("cron_run_requests")).toBe(1);
    expect(await count("cron_missed_alerts")).toBe(1);
  });

  test("per-slug override replaces the global window for that slug", async () => {
    const noisy = await addJob("noisy-md");
    const quiet = await addJob("quiet-md");
    await addInvocation(noisy, 10);
    await addInvocation(quiet, 10);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 }, // would keep both
      perSlug: { "noisy-md": { maxAgeDays: 7 } },
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    expect(await kit.invocationSlugs()).toEqual(["quiet-md"]);
  });

  test("a slug whose retention has no maxAgeDays is skipped (maxRuns is log-only)", async () => {
    const job = await addJob("foo-md");
    await addInvocation(job, 999);
    const report = await store.pruneLedger({ global: { maxRuns: 1 }, nowMs: NOW });
    expect(report.invocations).toBe(0);
    expect(await count("cron_invocations")).toBe(1);
  });

  test("running rows newer than 24h are never deleted; older running debris prunes", async () => {
    const job = await addJob("foo-md");
    // Zero-day window puts the cutoff at NOW — everything is "old", so only
    // the running-protection guard decides what survives.
    const freshRunning = await addInvocation(job, 2 / 24, "running"); // 2h old
    await addInvocation(job, 30 / 24, "running"); // 30h old — stale debris
    await addInvocation(job, 1 / 24, "ok");

    const report = await store.pruneLedger({ global: { maxAgeDays: 0 }, nowMs: NOW });

    expect(report.invocations).toBe(2);
    expect(await kit.invocationIds()).toEqual([freshRunning]);
    expect(RUNNING_PROTECT_MS).toBe(DAY);
  });

  test("cron_jobs rows are never deleted, even for deleted jobs", async () => {
    const job = await addJob("gone-md", "deleted");
    await addInvocation(job, 100);
    await store.pruneLedger({ global: { maxAgeDays: 30 }, nowMs: NOW });
    expect(await count("cron_invocations")).toBe(0);
    expect(await count("cron_jobs")).toBe(1);
  });

  test("a surviving run request's link to a doomed invocation is severed, not a FK error", async () => {
    const job = await addJob("foo-md");
    const oldInv = await addInvocation(job, 40);
    const reqId = await addRunRequest(job, 1, oldInv); // fresh request, old invocation

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    expect(report.runRequests).toBe(0);
    expect(await kit.runRequestInvocationId(reqId)).toBeNull();
  });

  test("onlySlug scopes row pruning to a single slug", async () => {
    const a = await addJob("a-md");
    const b = await addJob("b-md");
    await addInvocation(a, 40);
    await addInvocation(b, 40);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      onlySlug: "a-md",
      nowMs: NOW,
    });

    expect(report.invocations).toBe(1);
    expect(await count("cron_invocations")).toBe(1);
  });

  test("dry-run reports counts but deletes nothing", async () => {
    const job = await addJob("foo-md");
    await addInvocation(job, 40);
    await addRunRequest(job, 40);
    await addMissedAlert(job, 40);

    const report = await store.pruneLedger({
      global: { maxAgeDays: 30 },
      dryRun: true,
      nowMs: NOW,
    });

    expect(report).toEqual({ invocations: 1, runRequests: 1, missedAlerts: 1 });
    expect(await count("cron_invocations")).toBe(1);
    expect(await count("cron_run_requests")).toBe(1);
    expect(await count("cron_missed_alerts")).toBe(1);
  });
});
