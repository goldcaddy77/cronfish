import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  stopHousekeeping,
  tickOnce,
  type DaemonCtx,
  type SpawnRequest,
} from "../src/daemon.ts";
import { SqliteStore } from "../src/store/index.ts";

const DAY = 86_400_000;
const T0 = new Date("2026-07-17T12:00:00.000Z");

let root: string;
let cronDir: string;
let db: Database;
let ctx: DaemonCtx;

function iso(ageMs: number, from: Date = T0): string {
  return new Date(from.getTime() - ageMs).toISOString();
}

function addJobWithInvocation(slug: string, ageDays: number): void {
  db.prepare(
    `INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at, state)
     VALUES ($slug, 'md', 'every 30 seconds', 1, $now, 'active')
     ON CONFLICT(slug) DO NOTHING`,
  ).run({ $slug: slug, $now: iso(0) });
  const { id: jobId } = db
    .query("SELECT id FROM cron_jobs WHERE slug = $slug")
    .get({ $slug: slug }) as { id: number };
  db.prepare(
    `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
     VALUES ($job, $started, 'ok', 'schedule', '/tmp/x.log')`,
  ).run({ $job: jobId, $started: iso(ageDays * DAY) });
}

function invocationCount(): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM cron_invocations").get() as {
      n: number;
    }
  ).n;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cronfish-housekeeping-"));
  cronDir = join(root, "cron");
  mkdirSync(cronDir, { recursive: true });
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const store = new SqliteStore(db);
  await store.migrate();
  const spawns: SpawnRequest[] = [];
  ctx = {
    store,
    consumerRoot: root,
    cronDir,
    spawn: (req) => spawns.push(req),
    pid: 4242,
    startedAt: T0.toISOString(),
    log: () => {},
  };
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("daemon housekeeping", () => {
  test("prunes ledger rows once per UTC day when retention is configured", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ retention: { max_age_days: 30 } }),
      "utf-8",
    );
    addJobWithInvocation("foo-md", 40);

    await tickOnce(ctx, T0);

    await ctx.housekeeping;
    expect(invocationCount()).toBe(0);

    // Same day: a newly-aged row is NOT pruned again until tomorrow.
    addJobWithInvocation("foo-md", 40);
    await tickOnce(ctx, new Date(T0.getTime() + 60_000));
    await ctx.housekeeping;
    await tickOnce(ctx, new Date(T0.getTime() + 3_600_000));
    await ctx.housekeeping;
    expect(invocationCount()).toBe(1);

    // Next UTC day (T0 is 12:00Z, +13h crosses midnight): pruned again.
    await tickOnce(ctx, new Date(T0.getTime() + 13 * 3_600_000));
    await ctx.housekeeping;
    expect(invocationCount()).toBe(0);
  });

  test("per-slug override wins over the global window", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({
        retention: {
          max_age_days: 30,
          per_slug: { "noisy-md": { max_age_days: 7 } },
        },
      }),
      "utf-8",
    );
    addJobWithInvocation("noisy-md", 10);
    addJobWithInvocation("quiet-md", 10);

    await tickOnce(ctx, T0);

    await ctx.housekeeping;

    const slugs = db
      .query(
        `SELECT j.slug FROM cron_invocations i JOIN cron_jobs j ON j.id = i.job_id`,
      )
      .all() as { slug: string }[];
    expect(slugs.map((s) => s.slug)).toEqual(["quiet-md"]);
  });

  test("no retention configured → no rows are ever deleted", async () => {
    addJobWithInvocation("foo-md", 400);
    await tickOnce(ctx, T0);
    await ctx.housekeeping;
    await tickOnce(ctx, new Date(T0.getTime() + 2 * DAY));
    await ctx.housekeeping;
    expect(invocationCount()).toBe(1);
  });
});

// POS-1114: on a large log tree the first tick's prune walk took minutes, and
// it ran BEFORE the heartbeat. A supervisor that reads "no fresh heartbeat" as
// "dead daemon" restarted it mid-walk, forever. The heartbeat must never wait
// on housekeeping, and housekeeping must never hold the tick.
describe("daemon housekeeping never delays the heartbeat (POS-1114)", () => {
  function withRetention(): void {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ retention: { max_age_days: 30 } }),
      "utf-8",
    );
  }

  test("the first tick beats even when housekeeping never finishes", async () => {
    withRetention();
    // A ledger prune that never settles stands in for a minutes-long walk.
    ctx.store.pruneLedger = () => new Promise(() => {});
    const tick = tickOnce(ctx, T0).then(() => "ticked");
    const timeout = new Promise((r) => setTimeout(() => r("timed out"), 2_000));
    expect(await Promise.race([tick, timeout])).toBe("ticked");
    const hb = await ctx.store.getDaemonHeartbeat();
    expect(hb?.pid).toBe(4242);
  });

  test("the heartbeat is written before housekeeping starts", async () => {
    withRetention();
    const calls: string[] = [];
    const store = ctx.store;
    const beat = store.beatDaemonHeartbeat.bind(store);
    const prune = store.pruneLedger.bind(store);
    store.beatDaemonHeartbeat = (o) => {
      calls.push("beat");
      return beat(o);
    };
    store.pruneLedger = (o) => {
      calls.push("prune");
      return prune(o);
    };
    await tickOnce(ctx, T0);
    await ctx.housekeeping;
    expect(calls).toEqual(["beat", "prune"]);
  });

  test("a large log walk runs off the tick and still prunes", async () => {
    withRetention();
    const slugDir = join(root, ".cronfish", "logs", "noisy-md");
    mkdirSync(slugDir, { recursive: true });
    const old = new Date(T0.getTime() - 40 * DAY);
    const { utimesSync } = await import("node:fs");
    for (let i = 0; i < 2_000; i++) {
      const p = join(slugDir, `${i}.log`);
      writeFileSync(p, "x");
      utimesSync(p, old, old);
    }
    writeFileSync(join(slugDir, "fresh.log"), "x");
    const { readdirSync } = await import("node:fs");

    await tickOnce(ctx, T0);
    // The tick returned while the walk is still in flight.
    expect(ctx.housekeeping).toBeDefined();
    expect(readdirSync(slugDir).length).toBeGreaterThan(1);

    await ctx.housekeeping;
    expect(readdirSync(slugDir)).toEqual(["fresh.log"]);
  });

  test("a housekeeping run still in flight is not started twice", async () => {
    withRetention();
    let calls = 0;
    ctx.store.pruneLedger = () => {
      calls++;
      return new Promise(() => {});
    };
    await tickOnce(ctx, T0);
    // Next UTC day while the first run is still going: no second run.
    await tickOnce(ctx, new Date(T0.getTime() + DAY));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });
});

describe("housekeeping stops cleanly on shutdown (POS-1114 review)", () => {
  test("an aborted log walk deletes nothing and skips the ledger prune", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ retention: { max_age_days: 30 } }),
      "utf-8",
    );
    const slugDir = join(root, ".cronfish", "logs", "noisy-md");
    mkdirSync(slugDir, { recursive: true });
    const old = new Date(T0.getTime() - 40 * DAY);
    const { utimesSync, readdirSync } = await import("node:fs");
    for (let i = 0; i < 500; i++) {
      const p = join(slugDir, `${i}.log`);
      writeFileSync(p, "x");
      utimesSync(p, old, old);
    }
    let ledgerCalls = 0;
    ctx.store.pruneLedger = async () => {
      ledgerCalls++;
      return { invocations: 0, runRequests: 0, missedAlerts: 0 };
    };
    ctx.shutdown = new AbortController();
    await tickOnce(ctx, T0);
    ctx.shutdown.abort();
    await ctx.housekeeping;
    expect(ledgerCalls).toBe(0);
    expect(readdirSync(slugDir).length).toBe(500);
  });

  test("SQLite ledger prune deletes large backlogs in batches, all of them", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ retention: { max_age_days: 30 } }),
      "utf-8",
    );
    addJobWithInvocation("foo-md", 40);
    const { id: jobId } = db
      .query("SELECT id FROM cron_jobs WHERE slug = 'foo-md'")
      .get() as { id: number };
    const ins = db.prepare(
      `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
       VALUES ($job, $started, 'ok', 'schedule', '/tmp/x.log')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 12_000; i++) ins.run({ $job: jobId, $started: iso(40 * DAY) });
    })();
    addJobWithInvocation("foo-md", 1); // fresh row survives
    await tickOnce(ctx, T0);
    await ctx.housekeeping;
    expect(invocationCount()).toBe(1);
  });
});

describe("housekeeping yields and stops (POS-1114 skeptic pass)", () => {
  function seedManyJobs(jobs: number, perJob: number): void {
    const ins = db.prepare(
      `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
       VALUES ($job, $started, 'ok', 'schedule', '/tmp/x.log')`,
    );
    for (let j = 0; j < jobs; j++) {
      addJobWithInvocation(`job${j}-md`, 40);
      const { id } = db
        .query("SELECT id FROM cron_jobs WHERE slug = $s")
        .get({ $s: `job${j}-md` }) as { id: number };
      db.transaction(() => {
        for (let i = 1; i < perJob; i++) ins.run({ $job: id, $started: iso(40 * DAY) });
      })();
    }
  }

  test("the SQLite ledger prune yields the event loop between statements", async () => {
    seedManyJobs(50, 20);
    let spins = 0;
    let on = true;
    const spin = (): void => {
      spins++;
      if (on) setImmediate(spin);
    };
    spin();
    const report = await ctx.store.pruneLedger({ global: { maxAgeDays: 30 }, nowMs: T0.getTime() });
    on = false;
    expect(report.invocations).toBe(1_000);
    // One yield per job at least: a single blocking transaction gives ~1.
    expect(spins).toBeGreaterThan(40);
  });

  test("an aborted signal stops the SQLite ledger prune at the next boundary", async () => {
    seedManyJobs(5, 10);
    const ac = new AbortController();
    ac.abort();
    const report = await ctx.store.pruneLedger({
      global: { maxAgeDays: 30 },
      nowMs: T0.getTime(),
      signal: ac.signal,
    });
    expect(report.invocations).toBe(0);
    expect(invocationCount()).toBe(50);
  });

  test("stopHousekeeping aborts the run and waits at most waitMs", async () => {
    ctx.shutdown = new AbortController();
    ctx.housekeeping = new Promise(() => {}); // a run that never settles
    const t0 = Date.now();
    await stopHousekeeping(ctx, 50);
    expect(ctx.shutdown.signal.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("stopHousekeeping returns as soon as an aborted run settles", async () => {
    ctx.shutdown = new AbortController();
    const signal = ctx.shutdown.signal;
    ctx.housekeeping = new Promise<void>((r) => signal.addEventListener("abort", () => r()));
    const t0 = Date.now();
    await stopHousekeeping(ctx, 5_000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
