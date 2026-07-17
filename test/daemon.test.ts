import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { tickOnce, type DaemonCtx, type SpawnRequest } from "../src/daemon.ts";
import {
  finishInvocation,
  getDaemonHeartbeat,
  getJobIdBySlug,
  getRunRequest,
  insertRunRequest,
  listRunHistory,
  migrate,
  setJobLastRun,
  startInvocation,
} from "../src/db.ts";

const T0 = new Date("2026-07-17T12:00:00.000Z");

function at(minutes: number, seconds = 0): Date {
  return new Date(T0.getTime() + minutes * 60_000 + seconds * 1_000);
}

interface Harness {
  ctx: DaemonCtx;
  spawns: SpawnRequest[];
  db: Database;
  root: string;
  cronDir: string;
}

let harness: Harness;

function jobRow(db: Database, slug: string): Record<string, unknown> {
  return db
    .query("SELECT * FROM cron_jobs WHERE slug = $slug")
    .get({ $slug: slug }) as Record<string, unknown>;
}

// Job files get an explicit, strictly-increasing mtime so edits are always
// visible to the scan regardless of filesystem timestamp granularity.
let mtimeSeq = 1_000_000_000;
function writeJob(name: string, content: string): string {
  const path = join(harness.cronDir, name);
  writeFileSync(path, content, "utf-8");
  const t = new Date(++mtimeSeq * 1_000);
  utimesSync(path, t, t);
  return path;
}

function mdJob(schedule: string, extra = ""): string {
  return `---\nschedule: "${schedule}"\n${extra}---\n\nSay hello.\n`;
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cronfish-daemon-"));
  const cronDir = join(root, "cron");
  mkdirSync(cronDir, { recursive: true });
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  const spawns: SpawnRequest[] = [];
  harness = {
    root,
    cronDir,
    db,
    spawns,
    ctx: {
      db,
      consumerRoot: root,
      cronDir,
      spawn: (req) => spawns.push(req),
      pid: 4242,
      startedAt: T0.toISOString(),
      version: "test",
      log: () => {},
    },
  };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.root, { recursive: true, force: true });
});

describe("daemon tickOnce — dispatch", () => {
  test("first sight of a new job dispatches immediately and advances next_run", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(1);
    const s = harness.spawns[0]!;
    expect(s.slug).toBe("hello-md");
    expect(s.trigger).toBe("schedule");
    expect(s.jobPath).toBe(join(harness.cronDir, "hello.md"));
    expect(s.scheduledFor).toBe(T0.toISOString());
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );
  });

  test("a not-yet-due job does not dispatch", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    tickOnce(harness.ctx, at(0, 1));
    tickOnce(harness.ctx, at(4, 59));
    expect(harness.spawns).toHaveLength(1);
  });

  test("due within the grace tick stays trigger=schedule", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    tickOnce(harness.ctx, at(5, 30)); // 30s late < 60s grace
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.trigger).toBe("schedule");
  });

  test("catch-up coalescing: 3 missed intervals collapse to exactly ONE catchup run", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0); // dispatch #1, next_run = T0+5m
    // Daemon "down" through T0+5m, +10m, +15m; back at T0+16m.
    tickOnce(harness.ctx, at(16));
    expect(harness.spawns).toHaveLength(2);
    const s = harness.spawns[1]!;
    expect(s.trigger).toBe("catchup");
    expect(s.scheduledFor).toBe(at(5).toISOString()); // the missed slot
    // next_run recomputed from now, not from the missed era.
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(21).toISOString(),
    );
    // And the very next tick has nothing to do.
    tickOnce(harness.ctx, at(16, 1));
    expect(harness.spawns).toHaveLength(2);
  });
});

describe("daemon tickOnce — file sync", () => {
  test("schedule change picked up via mtime: next_run = max(now, last_run + new interval)", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    // Simulate the runner finishing the T0 run.
    const jobId = getJobIdBySlug(harness.db, "hello-md")!;
    setJobLastRun(harness.db, jobId, T0.toISOString(), "ok");

    // 5m → 1h with a 2-min-old last run lands 58 minutes out.
    writeJob("hello.md", mdJob("1h"));
    tickOnce(harness.ctx, at(2));
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(60).toISOString(),
    );
    expect(harness.spawns).toHaveLength(1); // no dispatch — not due

    // 1h → 1m with the same last run: overdue → clamped to now → fires
    // on this very tick (sync runs before dispatch).
    writeJob("hello.md", mdJob("1m"));
    tickOnce(harness.ctx, at(3));
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.trigger).toBe("schedule"); // clamped-to-now, not late
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(4).toISOString(),
    );
  });

  test("untouched files are not re-parsed (mtime scan)", () => {
    const path = writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    // Corrupt the file WITHOUT changing its mtime — an mtime-keyed scan must
    // never read it, so the schedule stays intact.
    writeFileSync(path, "---\nschedule: [broken\n---\n", "utf-8");
    const t = new Date(mtimeSeq * 1_000); // same stamp as writeJob set
    utimesSync(path, t, t);
    tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );
  });

  test("disabled job never dispatches", () => {
    writeJob("hello.md", mdJob("5m", "enabled: false\n"));
    tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(0);
    const row = jobRow(harness.db, "hello-md");
    expect(row.state).toBe("disabled");
    expect(row.next_run_at).toBeNull();
  });

  test("disabling an active job stops future dispatches", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    writeJob("hello.md", mdJob("5m", "enabled: false\n"));
    tickOnce(harness.ctx, at(10)); // long past due
    expect(harness.spawns).toHaveLength(1);
    expect(jobRow(harness.db, "hello-md").state).toBe("disabled");
  });

  test("deleted file → state=deleted, never dispatches, history retained", () => {
    const path = writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    // Record a finished run so there is history to retain.
    const jobId = getJobIdBySlug(harness.db, "hello-md")!;
    const inv = startInvocation(harness.db, jobId, "schedule", "/tmp/x.log");
    finishInvocation(harness.db, inv, "ok", 0);

    rmSync(path);
    tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "hello-md").state).toBe("deleted");
    tickOnce(harness.ctx, at(10)); // long past the old next_run
    expect(harness.spawns).toHaveLength(1);
    const history = listRunHistory(harness.db, { slug: "hello-md" });
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("ok");
  });

  test("a broken job file logs and never kills the tick", () => {
    writeJob("bad.md", "---\nschedule: [nope\n---\n");
    writeJob("good.md", mdJob("5m"));
    expect(() => tickOnce(harness.ctx, T0)).not.toThrow();
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.slug).toBe("good-md");
  });

  test("manual-schedule job syncs but never dispatches", () => {
    writeJob("byhand.md", mdJob("manual"));
    tickOnce(harness.ctx, T0);
    tickOnce(harness.ctx, at(60));
    expect(harness.spawns).toHaveLength(0);
    expect(jobRow(harness.db, "byhand-md").next_run_at).toBeNull();
  });
});

describe("daemon tickOnce — run requests", () => {
  test("drains a pending request exactly once, trigger=manual, request id passed through", () => {
    writeJob("hello.md", mdJob("1h"));
    tickOnce(harness.ctx, T0); // sync + immediate first run
    expect(harness.spawns).toHaveLength(1);

    const jobId = getJobIdBySlug(harness.db, "hello-md")!;
    const reqId = insertRunRequest(harness.db, jobId);
    tickOnce(harness.ctx, at(0, 1));
    expect(harness.spawns).toHaveLength(2);
    const s = harness.spawns[1]!;
    expect(s.trigger).toBe("manual");
    expect(s.runRequestId).toBe(reqId);
    expect(s.jobPath).toBe(join(harness.cronDir, "hello.md"));
    expect(getRunRequest(harness.db, reqId)!.picked_up_at).not.toBeNull();

    // Claimed — a later tick must not re-spawn it.
    tickOnce(harness.ctx, at(0, 2));
    expect(harness.spawns).toHaveLength(2);
  });
});

describe("daemon tickOnce — heartbeat", () => {
  test("beats every tick and counts ticks for the same process", () => {
    tickOnce(harness.ctx, T0);
    tickOnce(harness.ctx, at(0, 1));
    tickOnce(harness.ctx, at(0, 2));
    const hb = getDaemonHeartbeat(harness.db)!;
    expect(hb.pid).toBe(4242);
    expect(hb.tick_count).toBe(3);
    expect(hb.version).toBe("test");
    expect(Date.parse(hb.last_tick_at)).toBeGreaterThan(0);
  });
});
