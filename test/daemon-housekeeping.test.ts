import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { tickOnce, type DaemonCtx, type SpawnRequest } from "../src/daemon.ts";
import { migrate } from "../src/db.ts";

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cronfish-housekeeping-"));
  cronDir = join(root, "cron");
  mkdirSync(cronDir, { recursive: true });
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const spawns: SpawnRequest[] = [];
  ctx = {
    db,
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
  test("prunes ledger rows once per UTC day when retention is configured", () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ retention: { max_age_days: 30 } }),
      "utf-8",
    );
    addJobWithInvocation("foo-md", 40);

    tickOnce(ctx, T0);
    expect(invocationCount()).toBe(0);

    // Same day: a newly-aged row is NOT pruned again until tomorrow.
    addJobWithInvocation("foo-md", 40);
    tickOnce(ctx, new Date(T0.getTime() + 60_000));
    tickOnce(ctx, new Date(T0.getTime() + 3_600_000));
    expect(invocationCount()).toBe(1);

    // Next UTC day (T0 is 12:00Z, +13h crosses midnight): pruned again.
    tickOnce(ctx, new Date(T0.getTime() + 13 * 3_600_000));
    expect(invocationCount()).toBe(0);
  });

  test("per-slug override wins over the global window", () => {
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

    tickOnce(ctx, T0);

    const slugs = db
      .query(
        `SELECT j.slug FROM cron_invocations i JOIN cron_jobs j ON j.id = i.job_id`,
      )
      .all() as { slug: string }[];
    expect(slugs.map((s) => s.slug)).toEqual(["quiet-md"]);
  });

  test("no retention configured → no rows are ever deleted", () => {
    addJobWithInvocation("foo-md", 400);
    tickOnce(ctx, T0);
    tickOnce(ctx, new Date(T0.getTime() + 2 * DAY));
    expect(invocationCount()).toBe(1);
  });
});
