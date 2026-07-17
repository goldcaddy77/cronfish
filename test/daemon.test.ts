import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  acquireDaemonExclusivity,
  daemonLockPath,
  tickOnce,
  type DaemonCtx,
  type SpawnRequest,
} from "../src/daemon.ts";
import {
  beatDaemonHeartbeat,
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

  test("untouched files are not re-parsed (size+mtime scan)", () => {
    const path = writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    // Corrupt the file WITHOUT changing its mtime OR size — a size+mtime
    // keyed scan must never read it, so the schedule stays intact.
    const original = readFileSync(path, "utf-8");
    const corrupted = original.replace('schedule: "5m"', 'schedule: "[b"');
    expect(corrupted.length).toBe(original.length);
    writeFileSync(path, corrupted, "utf-8");
    const t = new Date(mtimeSeq * 1_000); // same stamp as writeJob set
    utimesSync(path, t, t);
    tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );
  });

  test("mtime-preserving replacement (cp -p) is detected via size", () => {
    const path = writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);
    // Replace with a different-length file but the SAME mtime — the size
    // half of the change key must pick it up.
    writeFileSync(path, mdJob("1h", "description: swapped in\n"), "utf-8");
    const t = new Date(mtimeSeq * 1_000);
    utimesSync(path, t, t);
    tickOnce(harness.ctx, at(0, 1));
    const row = jobRow(harness.db, "hello-md");
    expect(row.schedule).toBe("1h");
    expect(row.description).toBe("swapped in");
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

describe("daemon tickOnce — one-time jobs", () => {
  function oneTimeJob(runAtIso: string, extra = ""): string {
    return `---\nrun_at: "${runAtIso}"\n${extra}---\n\nSay hi once.\n`;
  }

  function writeOneTime(name: string, content: string): string {
    mkdirSync(join(harness.cronDir, "one-time"), { recursive: true });
    return writeJob(join("one-time", name), content);
  }

  test("future run_at → schedule_kind=once, next_run=run_at, dispatched exactly once", () => {
    writeOneTime("boom.md", oneTimeJob(at(2).toISOString()));
    tickOnce(harness.ctx, T0);
    const row = jobRow(harness.db, "one-time/boom-md");
    expect(row.schedule_kind).toBe("once");
    expect(row.next_run_at).toBe(at(2).toISOString());
    expect(harness.spawns).toHaveLength(0); // not due yet

    tickOnce(harness.ctx, at(2));
    expect(harness.spawns).toHaveLength(1);
    const s = harness.spawns[0]!;
    expect(s.slug).toBe("one-time/boom-md");
    expect(s.trigger).toBe("schedule");
    expect(s.scheduledFor).toBe(at(2).toISOString());
    // Never recurs: parked at NULL immediately after dispatch.
    expect(jobRow(harness.db, "one-time/boom-md").next_run_at).toBeNull();

    tickOnce(harness.ctx, at(3));
    tickOnce(harness.ctx, at(60));
    expect(harness.spawns).toHaveLength(1);
  });

  test("run_at missed across daemon downtime → single catchup dispatch", () => {
    writeOneTime("late.md", oneTimeJob(at(1).toISOString()));
    tickOnce(harness.ctx, T0);
    // Daemon down through at(1); back at at(10).
    tickOnce(harness.ctx, at(10));
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.trigger).toBe("catchup");
    expect(jobRow(harness.db, "one-time/late-md").next_run_at).toBeNull();
  });

  test("executed_at already stamped → never scheduled, never dispatched", () => {
    writeOneTime(
      "done.md",
      oneTimeJob(at(1).toISOString(), `executed_at: "${T0.toISOString()}"\n`),
    );
    tickOnce(harness.ctx, T0);
    const row = jobRow(harness.db, "one-time/done-md");
    expect(row.schedule_kind).toBe("once");
    expect(row.next_run_at).toBeNull();
    tickOnce(harness.ctx, at(30));
    expect(harness.spawns).toHaveLength(0);
  });

  test("stamped-under-lock edit (executed_at appears) un-schedules a pending one-time", () => {
    writeOneTime("pending.md", oneTimeJob(at(5).toISOString()));
    tickOnce(harness.ctx, T0);
    expect(jobRow(harness.db, "one-time/pending-md").next_run_at).toBe(
      at(5).toISOString(),
    );
    // The runner stamps executed_at into the file (e.g. a manual run).
    writeOneTime(
      "pending.md",
      oneTimeJob(at(5).toISOString(), `executed_at: "${at(1).toISOString()}"\n`),
    );
    tickOnce(harness.ctx, at(2));
    expect(jobRow(harness.db, "one-time/pending-md").next_run_at).toBeNull();
    tickOnce(harness.ctx, at(10));
    expect(harness.spawns).toHaveLength(0);
  });
});

describe("daemon tickOnce — dispatch error handling", () => {
  test("DB error while advancing next_run skips the spawn and retries next tick", () => {
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0); // first run, next_run = T0+5m
    expect(harness.spawns).toHaveLength(1);

    // Make every write fail (simulated SQLITE_BUSY/IO error). The due job
    // must NOT spawn — an unrecorded advance would double-run — and
    // next_run_at must stay untouched for the retry.
    harness.db.exec("PRAGMA query_only = ON");
    tickOnce(harness.ctx, at(5));
    expect(harness.spawns).toHaveLength(1); // no spawn
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );

    // DB recovers → the very next tick dispatches the still-due row.
    harness.db.exec("PRAGMA query_only = OFF");
    tickOnce(harness.ctx, at(5, 30));
    expect(harness.spawns).toHaveLength(2);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(10, 30).toISOString(),
    );
  });

  test("never-occurring cron expr parks once with one log line — no 1 Hz spam", () => {
    const logs: string[] = [];
    harness.ctx.log = (m) => logs.push(m);
    writeJob("hello.md", mdJob("5m"));
    tickOnce(harness.ctx, T0);

    // Schedule mutates to a valid-looking cron with no future occurrence
    // (Feb 30) and the row is due.
    harness.db
      .prepare(
        `UPDATE cron_jobs SET schedule = '0 0 30 2 *', schedule_kind = 'cron',
         next_run_at = $due WHERE slug = 'hello-md'`,
      )
      .run({ $due: at(1).toISOString() });
    // Keep the file scan quiet about it (row matches file stat already).

    tickOnce(harness.ctx, at(1));
    // The due slot still ran (it WAS due), then parked.
    expect(harness.spawns).toHaveLength(2);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBeNull();
    const parkLogs = logs.filter((l) => l.includes("parked"));
    expect(parkLogs).toHaveLength(1);

    // Subsequent ticks: no re-dispatch, no repeated park/rescue logging.
    tickOnce(harness.ctx, at(1, 1));
    tickOnce(harness.ctx, at(1, 2));
    tickOnce(harness.ctx, at(2));
    expect(harness.spawns).toHaveLength(2);
    expect(logs.filter((l) => l.includes("parked"))).toHaveLength(1);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBeNull();

    // A file edit un-parks it.
    writeJob("hello.md", mdJob("1m"));
    tickOnce(harness.ctx, at(3));
    expect(jobRow(harness.db, "hello-md").next_run_at).not.toBeNull();
  });
});

describe("daemon tickOnce — run request spawn failure", () => {
  test("spawn failure releases the claim so the next tick retries", () => {
    writeJob("hello.md", mdJob("1h"));
    tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(1);

    const jobId = getJobIdBySlug(harness.db, "hello-md")!;
    const reqId = insertRunRequest(harness.db, jobId);

    let failNext = true;
    const realSpawn = harness.ctx.spawn;
    harness.ctx.spawn = (req) => {
      if (failNext && req.runRequestId !== undefined) {
        failNext = false;
        throw new Error("spawn exploded");
      }
      realSpawn(req);
    };

    tickOnce(harness.ctx, at(0, 1)); // spawn throws → claim released
    expect(harness.spawns).toHaveLength(1);
    expect(getRunRequest(harness.db, reqId)!.picked_up_at).toBeNull();

    tickOnce(harness.ctx, at(0, 2)); // retried and succeeds
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.runRequestId).toBe(reqId);
    expect(getRunRequest(harness.db, reqId)!.picked_up_at).not.toBeNull();
  });
});

describe("daemon mutual exclusion", () => {
  test("refuses when another live pid has a fresh heartbeat", () => {
    // process.pid is definitionally alive and != the candidate pid.
    beatDaemonHeartbeat(harness.db, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const r = acquireDaemonExclusivity(harness.db, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`pid ${process.pid}`);
  });

  test("a stale heartbeat or a dead pid does not block startup", async () => {
    // Stale tick from a live pid → not fresh → allowed.
    beatDaemonHeartbeat(harness.db, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    harness.db
      .prepare("UPDATE cron_daemon_heartbeat SET last_tick_at = $t")
      .run({ $t: new Date(Date.now() - 60_000).toISOString() });
    let r = acquireDaemonExclusivity(harness.db, harness.root, 4242);
    expect(r.ok).toBe(true);
    rmSync(daemonLockPath(harness.root));

    // Fresh tick but from a DEAD pid → allowed.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    beatDaemonHeartbeat(harness.db, {
      pid: dead.pid,
      startedAt: new Date().toISOString(),
    });
    r = acquireDaemonExclusivity(harness.db, harness.root, 4242);
    expect(r.ok).toBe(true);
    expect(readFileSync(daemonLockPath(harness.root), "utf-8").trim()).toBe(
      "4242",
    );
  });

  test("lock file held by a live pid refuses; a dead holder is taken over", async () => {
    const lock = daemonLockPath(harness.root);
    mkdirSync(join(harness.root, ".cronfish"), { recursive: true });

    // Live holder → refuse.
    writeFileSync(lock, String(process.pid), "utf-8");
    let r = acquireDaemonExclusivity(harness.db, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("daemon lock");

    // Dead holder → stale-lock takeover.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lock, String(dead.pid), "utf-8");
    r = acquireDaemonExclusivity(harness.db, harness.root, 4242);
    expect(r.ok).toBe(true);
    expect(readFileSync(lock, "utf-8").trim()).toBe("4242");
    expect(existsSync(lock)).toBe(true);
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
