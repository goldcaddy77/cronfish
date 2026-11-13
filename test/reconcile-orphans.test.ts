// Boot reconcile of rows a previous daemon life left 'running'. Runs against
// every store backend (SQLite always, Postgres when a test database is
// reachable) via the shared harness.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { maxRunMs } from "../src/runner.ts";
import { reconcileOrphanedRuns } from "../src/daemon.ts";
import type { CronStore } from "../src/store/index.ts";
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

const HOUR_MS = 3_600_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

describe("maxRunMs", () => {
  test("covers every attempt's timeout, the retry waits and a grace", () => {
    // default timeout 300s, no retries: 300s + 60s grace
    expect(maxRunMs(null, 0)).toBe(360_000);
    // 2 retries at 100s: 3 * 100 + waits 5 + 15, + 60s grace
    expect(maxRunMs(100, 2)).toBe((300 + 5 + 15) * 1000 + 60_000);
  });
});

describe.each(BACKENDS)("boot reconcile [%s]", (_name, factory) => {
  let store: CronStore;
  let kit: StoreKit;
  let dispose: () => Promise<void>;
  let logs: string[];
  const log = (m: string): void => void logs.push(m);

  beforeEach(async () => {
    const built = await factory();
    store = built.store;
    kit = built.kit;
    dispose = built.dispose;
    logs = [];
  });
  afterEach(async () => {
    await dispose();
  });

  async function seedRunning(
    slug: string,
    startedAt: string,
    jobOpts: Partial<JobMeta> = {},
  ): Promise<number> {
    await store.upsertJob(meta({ slug, ...jobOpts }));
    const jobId = (await store.getJobIdBySlug(slug))!;
    const before = new Set(await kit.invocationIds());
    await kit.seedInvocation(jobId, { startedAt, status: "running" });
    return (await kit.invocationIds()).find((i) => !before.has(i))!;
  }

  const fields = async (id: number) =>
    (await kit.invocationFields(id, [
      "status",
      "finished_at",
      "duration_ms",
      "exit_code",
    ]))! as {
      status: string;
      finished_at: string | null;
      duration_ms: number | null;
      exit_code: number | null;
    };

  test("repairs an orphaned row and logs the count once", async () => {
    const id = await seedRunning("a-md", ago(2 * HOUR_MS));
    expect(await reconcileOrphanedRuns(store, { log })).toBe(1);
    const row = await fields(id);
    expect(row.status).toBe("crashed");
    expect(row.finished_at).not.toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(HOUR_MS);
    expect(row.exit_code).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("reconciled 1 orphaned run");
  });

  test("leaves a live run alone", async () => {
    await store.upsertJob(meta({ slug: "live-md" }));
    const jobId = (await store.getJobIdBySlug("live-md"))!;
    const id = await store.startInvocation(jobId, "schedule", "/tmp/l.log");
    expect(await reconcileOrphanedRuns(store, { log })).toBe(0);
    expect((await fields(id)).status).toBe("running");
    expect(logs).toEqual([]);
  });

  test("judges each row against its own job's timeout", async () => {
    const started = ago(30 * 60_000); // 30 minutes ago
    const longJob = await seedRunning("long-md", started, { timeout: 3600 });
    const shortJob = await seedRunning("short-md", started, { timeout: 60 });
    expect(await reconcileOrphanedRuns(store, { log })).toBe(1);
    expect((await fields(longJob)).status).toBe("running");
    expect((await fields(shortJob)).status).toBe("crashed");
  });

  test("a runner that finishes after the reconcile wins", async () => {
    const id = await seedRunning("late-md", ago(2 * HOUR_MS));
    await reconcileOrphanedRuns(store, { log });
    expect((await fields(id)).status).toBe("crashed");
    await store.finishInvocation(id, "ok", 0, { summary: "done", ok: true });
    const row = await fields(id);
    expect(row.status).toBe("ok");
    expect(row.exit_code).toBe(0);
  });

  test("a reconcile never overwrites a row that already finished", async () => {
    const id = await seedRunning("done-md", ago(2 * HOUR_MS));
    await store.finishInvocation(id, "ok", 0);
    // Even a predicate that accepts everything cannot flip a finished row.
    expect(await store.reconcileRunningInvocations(() => true)).toBe(0);
    expect((await fields(id)).status).toBe("ok");
    expect(await reconcileOrphanedRuns(store, { log })).toBe(0);
    expect((await fields(id)).status).toBe("ok");
  });

  test("nothing to repair logs nothing and is idempotent", async () => {
    expect(await reconcileOrphanedRuns(store, { log })).toBe(0);
    await seedRunning("b-md", ago(2 * HOUR_MS));
    expect(await reconcileOrphanedRuns(store, { log })).toBe(1);
    expect(await reconcileOrphanedRuns(store, { log })).toBe(0);
    expect(logs).toHaveLength(1);
  });
});
