import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { SqliteStore } from "../src/store/index.ts";

const T0 = new Date("2026-07-17T12:00:00.000Z");

function at(minutes: number, seconds = 0): Date {
  return new Date(T0.getTime() + minutes * 60_000 + seconds * 1_000);
}

interface Harness {
  ctx: DaemonCtx;
  spawns: SpawnRequest[];
  db: Database;
  store: SqliteStore;
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

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "cronfish-daemon-"));
  const cronDir = join(root, "cron");
  mkdirSync(cronDir, { recursive: true });
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const store = new SqliteStore(db);
  await store.migrate();
  const spawns: SpawnRequest[] = [];
  harness = {
    root,
    cronDir,
    db,
    store,
    spawns,
    ctx: {
      store,
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
  test("first sight of a new job dispatches immediately and advances next_run", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
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

  test("a not-yet-due job does not dispatch", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    await tickOnce(harness.ctx, at(0, 1));
    await tickOnce(harness.ctx, at(4, 59));
    expect(harness.spawns).toHaveLength(1);
  });

  test("due within the grace tick stays trigger=schedule", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    await tickOnce(harness.ctx, at(5, 30)); // 30s late < 60s grace
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.trigger).toBe("schedule");
  });

  test("catch-up coalescing: 3 missed intervals collapse to exactly ONE catchup run", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0); // dispatch #1, next_run = T0+5m
    // Daemon "down" through T0+5m, +10m, +15m; back at T0+16m.
    await tickOnce(harness.ctx, at(16));
    expect(harness.spawns).toHaveLength(2);
    const s = harness.spawns[1]!;
    expect(s.trigger).toBe("catchup");
    expect(s.scheduledFor).toBe(at(5).toISOString()); // the missed slot
    // next_run recomputed from now, not from the missed era.
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(21).toISOString(),
    );
    // And the very next tick has nothing to do.
    await tickOnce(harness.ctx, at(16, 1));
    expect(harness.spawns).toHaveLength(2);
  });
});

describe("daemon tickOnce — file sync", () => {
  test("schedule change picked up via mtime: next_run = max(now, last_run + new interval)", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    // Simulate the runner finishing the T0 run.
    const jobId = (await harness.store.getJobIdBySlug("hello-md"))!;
    await harness.store.setJobLastRun(jobId, T0.toISOString(), "ok");

    // 5m → 1h with a 2-min-old last run lands 58 minutes out.
    writeJob("hello.md", mdJob("1h"));
    await tickOnce(harness.ctx, at(2));
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(60).toISOString(),
    );
    expect(harness.spawns).toHaveLength(1); // no dispatch — not due

    // 1h → 1m with the same last run: overdue → clamped to now → fires
    // on this very tick (sync runs before dispatch).
    writeJob("hello.md", mdJob("1m"));
    await tickOnce(harness.ctx, at(3));
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.trigger).toBe("schedule"); // clamped-to-now, not late
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(4).toISOString(),
    );
  });

  test("untouched files are not re-parsed (size+mtime scan)", async () => {
    const path = writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    // Corrupt the file WITHOUT changing its mtime OR size — a size+mtime
    // keyed scan must never read it, so the schedule stays intact.
    const original = readFileSync(path, "utf-8");
    const corrupted = original.replace('schedule: "5m"', 'schedule: "[b"');
    expect(corrupted.length).toBe(original.length);
    writeFileSync(path, corrupted, "utf-8");
    const t = new Date(mtimeSeq * 1_000); // same stamp as writeJob set
    utimesSync(path, t, t);
    await tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );
  });

  test("mtime-preserving replacement (cp -p) is detected via size", async () => {
    const path = writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    // Replace with a different-length file but the SAME mtime — the size
    // half of the change key must pick it up.
    writeFileSync(path, mdJob("1h", "description: swapped in\n"), "utf-8");
    const t = new Date(mtimeSeq * 1_000);
    utimesSync(path, t, t);
    await tickOnce(harness.ctx, at(0, 1));
    const row = jobRow(harness.db, "hello-md");
    expect(row.schedule).toBe("1h");
    expect(row.description).toBe("swapped in");
  });

  test("disabled job never dispatches", async () => {
    writeJob("hello.md", mdJob("5m", "enabled: false\n"));
    await tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(0);
    const row = jobRow(harness.db, "hello-md");
    expect(row.state).toBe("disabled");
    expect(row.next_run_at).toBeNull();
  });

  test("disabling an active job stops future dispatches", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    writeJob("hello.md", mdJob("5m", "enabled: false\n"));
    await tickOnce(harness.ctx, at(10)); // long past due
    expect(harness.spawns).toHaveLength(1);
    expect(jobRow(harness.db, "hello-md").state).toBe("disabled");
  });

  test("deleted file → state=deleted, never dispatches, history retained", async () => {
    const path = writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    // Record a finished run so there is history to retain.
    const jobId = (await harness.store.getJobIdBySlug("hello-md"))!;
    const inv = await harness.store.startInvocation(
      jobId,
      "schedule",
      "/tmp/x.log",
    );
    await harness.store.finishInvocation(inv, "ok", 0);

    rmSync(path);
    await tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "hello-md").state).toBe("deleted");
    await tickOnce(harness.ctx, at(10)); // long past the old next_run
    expect(harness.spawns).toHaveLength(1);
    const history = await harness.store.listRunHistory({ slug: "hello-md" });
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("ok");
  });

  test("a broken job file logs and never kills the tick", async () => {
    writeJob("bad.md", "---\nschedule: [nope\n---\n");
    writeJob("good.md", mdJob("5m"));
    await expect(tickOnce(harness.ctx, T0)).resolves.toBeUndefined();
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.slug).toBe("good-md");
  });

  test("manual-schedule job syncs but never dispatches", async () => {
    writeJob("byhand.md", mdJob("manual"));
    await tickOnce(harness.ctx, T0);
    await tickOnce(harness.ctx, at(60));
    expect(harness.spawns).toHaveLength(0);
    expect(jobRow(harness.db, "byhand-md").next_run_at).toBeNull();
  });
});

describe("daemon tickOnce — run requests", () => {
  test("drains a pending request exactly once, trigger=manual, request id passed through", async () => {
    writeJob("hello.md", mdJob("1h"));
    await tickOnce(harness.ctx, T0); // sync + immediate first run
    expect(harness.spawns).toHaveLength(1);

    const jobId = (await harness.store.getJobIdBySlug("hello-md"))!;
    const reqId = await harness.store.insertRunRequest(jobId);
    await tickOnce(harness.ctx, at(0, 1));
    expect(harness.spawns).toHaveLength(2);
    const s = harness.spawns[1]!;
    expect(s.trigger).toBe("manual");
    expect(s.runRequestId).toBe(reqId);
    expect(s.jobPath).toBe(join(harness.cronDir, "hello.md"));
    expect((await harness.store.getRunRequest(reqId))!.picked_up_at).not.toBeNull();

    // Claimed — a later tick must not re-spawn it.
    await tickOnce(harness.ctx, at(0, 2));
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

  test("future run_at → schedule_kind=once, next_run=run_at, dispatched exactly once", async () => {
    writeOneTime("boom.md", oneTimeJob(at(2).toISOString()));
    await tickOnce(harness.ctx, T0);
    const row = jobRow(harness.db, "one-time/boom-md");
    expect(row.schedule_kind).toBe("once");
    expect(row.next_run_at).toBe(at(2).toISOString());
    expect(harness.spawns).toHaveLength(0); // not due yet

    await tickOnce(harness.ctx, at(2));
    expect(harness.spawns).toHaveLength(1);
    const s = harness.spawns[0]!;
    expect(s.slug).toBe("one-time/boom-md");
    expect(s.trigger).toBe("schedule");
    expect(s.scheduledFor).toBe(at(2).toISOString());
    // Never recurs: parked at NULL immediately after dispatch.
    expect(jobRow(harness.db, "one-time/boom-md").next_run_at).toBeNull();

    await tickOnce(harness.ctx, at(3));
    await tickOnce(harness.ctx, at(60));
    expect(harness.spawns).toHaveLength(1);
  });

  test("run_at missed across daemon downtime → single catchup dispatch", async () => {
    writeOneTime("late.md", oneTimeJob(at(1).toISOString()));
    await tickOnce(harness.ctx, T0);
    // Daemon down through at(1); back at at(10).
    await tickOnce(harness.ctx, at(10));
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.trigger).toBe("catchup");
    expect(jobRow(harness.db, "one-time/late-md").next_run_at).toBeNull();
  });

  test("executed_at already stamped → never scheduled, never dispatched", async () => {
    writeOneTime(
      "done.md",
      oneTimeJob(at(1).toISOString(), `executed_at: "${T0.toISOString()}"\n`),
    );
    await tickOnce(harness.ctx, T0);
    const row = jobRow(harness.db, "one-time/done-md");
    expect(row.schedule_kind).toBe("once");
    expect(row.next_run_at).toBeNull();
    await tickOnce(harness.ctx, at(30));
    expect(harness.spawns).toHaveLength(0);
  });

  test("stamped-under-lock edit (executed_at appears) un-schedules a pending one-time", async () => {
    writeOneTime("pending.md", oneTimeJob(at(5).toISOString()));
    await tickOnce(harness.ctx, T0);
    expect(jobRow(harness.db, "one-time/pending-md").next_run_at).toBe(
      at(5).toISOString(),
    );
    // The runner stamps executed_at into the file (e.g. a manual run).
    writeOneTime(
      "pending.md",
      oneTimeJob(at(5).toISOString(), `executed_at: "${at(1).toISOString()}"\n`),
    );
    await tickOnce(harness.ctx, at(2));
    expect(jobRow(harness.db, "one-time/pending-md").next_run_at).toBeNull();
    await tickOnce(harness.ctx, at(10));
    expect(harness.spawns).toHaveLength(0);
  });
});

describe("daemon tickOnce — dispatch error handling", () => {
  test("DB error while advancing next_run skips the spawn and retries next tick", async () => {
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0); // first run, next_run = T0+5m
    expect(harness.spawns).toHaveLength(1);

    // Make every write fail (simulated SQLITE_BUSY/IO error). The due job
    // must NOT spawn — an unrecorded advance would double-run — and
    // next_run_at must stay untouched for the retry.
    harness.db.exec("PRAGMA query_only = ON");
    await tickOnce(harness.ctx, at(5));
    expect(harness.spawns).toHaveLength(1); // no spawn
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(5).toISOString(),
    );

    // DB recovers → the very next tick dispatches the still-due row.
    harness.db.exec("PRAGMA query_only = OFF");
    await tickOnce(harness.ctx, at(5, 30));
    expect(harness.spawns).toHaveLength(2);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBe(
      at(10, 30).toISOString(),
    );
  });

  test("never-occurring cron expr parks once with one log line — no 1 Hz spam", async () => {
    const logs: string[] = [];
    harness.ctx.log = (m) => logs.push(m);
    writeJob("hello.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);

    // Schedule mutates to a valid-looking cron with no future occurrence
    // (Feb 30) and the row is due.
    harness.db
      .prepare(
        `UPDATE cron_jobs SET schedule = '0 0 30 2 *', schedule_kind = 'cron',
         next_run_at = $due WHERE slug = 'hello-md'`,
      )
      .run({ $due: at(1).toISOString() });
    // Keep the file scan quiet about it (row matches file stat already).

    await tickOnce(harness.ctx, at(1));
    // The due slot still ran (it WAS due), then parked.
    expect(harness.spawns).toHaveLength(2);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBeNull();
    const parkLogs = logs.filter((l) => l.includes("parked"));
    expect(parkLogs).toHaveLength(1);

    // Subsequent ticks: no re-dispatch, no repeated park/rescue logging.
    await tickOnce(harness.ctx, at(1, 1));
    await tickOnce(harness.ctx, at(1, 2));
    await tickOnce(harness.ctx, at(2));
    expect(harness.spawns).toHaveLength(2);
    expect(logs.filter((l) => l.includes("parked"))).toHaveLength(1);
    expect(jobRow(harness.db, "hello-md").next_run_at).toBeNull();

    // A file edit un-parks it.
    writeJob("hello.md", mdJob("1m"));
    await tickOnce(harness.ctx, at(3));
    expect(jobRow(harness.db, "hello-md").next_run_at).not.toBeNull();
  });
});

describe("daemon tickOnce — run request spawn failure", () => {
  test("spawn failure releases the claim so the next tick retries", async () => {
    writeJob("hello.md", mdJob("1h"));
    await tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(1);

    const jobId = (await harness.store.getJobIdBySlug("hello-md"))!;
    const reqId = await harness.store.insertRunRequest(jobId);

    let failNext = true;
    const realSpawn = harness.ctx.spawn;
    harness.ctx.spawn = (req) => {
      if (failNext && req.runRequestId !== undefined) {
        failNext = false;
        throw new Error("spawn exploded");
      }
      realSpawn(req);
    };

    await tickOnce(harness.ctx, at(0, 1)); // spawn throws → claim released
    expect(harness.spawns).toHaveLength(1);
    expect((await harness.store.getRunRequest(reqId))!.picked_up_at).toBeNull();

    await tickOnce(harness.ctx, at(0, 2)); // retried and succeeds
    expect(harness.spawns).toHaveLength(2);
    expect(harness.spawns[1]!.runRequestId).toBe(reqId);
    expect((await harness.store.getRunRequest(reqId))!.picked_up_at).not.toBeNull();
  });
});

describe("daemon mutual exclusion", () => {
  test("refuses when another live pid has a fresh heartbeat", async () => {
    // process.pid is definitionally alive and != the candidate pid.
    await harness.store.beatDaemonHeartbeat({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`pid ${process.pid}`);
  });

  test("a stale heartbeat or a dead pid does not block startup", async () => {
    // Stale tick from a live pid → not fresh → allowed.
    await harness.store.beatDaemonHeartbeat({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    harness.db
      .prepare("UPDATE cron_daemon_heartbeat SET last_tick_at = $t")
      .run({ $t: new Date(Date.now() - 60_000).toISOString() });
    let r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(true);
    rmSync(daemonLockPath(harness.root));

    // Fresh tick but from a DEAD pid → allowed.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await harness.store.beatDaemonHeartbeat({
      pid: dead.pid,
      startedAt: new Date().toISOString(),
    });
    r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
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
    let r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("daemon lock");

    // Dead holder → stale-lock takeover.
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(lock, String(dead.pid), "utf-8");
    r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(true);
    expect(readFileSync(lock, "utf-8").trim()).toBe("4242");
    expect(existsSync(lock)).toBe(true);
  });
});

describe("daemon tickOnce — one-time loss recovery (A1)", () => {
  function oneTimeJob(runAtIso: string, extra = ""): string {
    return `---\nrun_at: "${runAtIso}"\n${extra}---\n\nSay hi once.\n`;
  }

  function writeOneTime(name: string, content: string): string {
    mkdirSync(join(harness.cronDir, "one-time"), { recursive: true });
    return writeJob(join("one-time", name), content);
  }

  // A fresh ctx over the same db + files = a daemon restart after a crash.
  function restartedCtx(): DaemonCtx {
    return { ...harness.ctx, parked: undefined, dispatchedOnce: undefined };
  }

  test("spawn failure restores next_run_at so the next tick retries", async () => {
    writeOneTime("boom.md", oneTimeJob(at(1).toISOString()));
    await tickOnce(harness.ctx, T0);
    expect(jobRow(harness.db, "one-time/boom-md").next_run_at).toBe(
      at(1).toISOString(),
    );

    let failNext = true;
    const realSpawn = harness.ctx.spawn;
    harness.ctx.spawn = (req) => {
      if (failNext) {
        failNext = false;
        throw new Error("spawn exploded");
      }
      realSpawn(req);
    };

    await tickOnce(harness.ctx, at(1)); // spawn throws → next_run_at restored
    expect(harness.spawns).toHaveLength(0);
    expect(jobRow(harness.db, "one-time/boom-md").next_run_at).toBe(
      at(1).toISOString(),
    );

    await tickOnce(harness.ctx, at(1, 1)); // retried and succeeds — exactly once
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.slug).toBe("one-time/boom-md");
    expect(jobRow(harness.db, "one-time/boom-md").next_run_at).toBeNull();
    await tickOnce(harness.ctx, at(2));
    expect(harness.spawns).toHaveLength(1);
  });

  test("crash between advance and spawn: restart rescues the NULLed one-shot", async () => {
    writeOneTime("crash.md", oneTimeJob(at(1).toISOString()));
    await tickOnce(harness.ctx, T0);
    // Simulate the crash window: next_run_at NULLed but nothing spawned.
    harness.db
      .prepare(
        "UPDATE cron_jobs SET next_run_at = NULL WHERE slug = 'one-time/crash-md'",
      )
      .run();

    // Restarted daemon (empty dispatchedOnce): the once-repair restores
    // next_run_at from the file's run_at, and the same tick dispatches it.
    const ctx2 = restartedCtx();
    await tickOnce(ctx2, at(2));
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.slug).toBe("one-time/crash-md");
    expect(jobRow(harness.db, "one-time/crash-md").next_run_at).toBeNull();

    // Post-dispatch NULL is now the "runner owns it" state — no churn.
    await tickOnce(ctx2, at(2, 1));
    await tickOnce(ctx2, at(3));
    expect(harness.spawns).toHaveLength(1);
  });

  test("crash-window loss past run_at+grace: sentinel written, parked, never runs", async () => {
    const logs: string[] = [];
    harness.ctx.log = (m) => logs.push(m);
    writeOneTime("gone.md", oneTimeJob(at(1).toISOString()));
    await tickOnce(harness.ctx, T0);
    harness.db
      .prepare(
        "UPDATE cron_jobs SET next_run_at = NULL WHERE slug = 'one-time/gone-md'",
      )
      .run();

    // Restart 30 min later — default grace is 5 min, so the slot is lost.
    const ctx2 = restartedCtx();
    ctx2.log = (m) => logs.push(m);
    await tickOnce(ctx2, at(30));
    expect(harness.spawns).toHaveLength(0);
    expect(jobRow(harness.db, "one-time/gone-md").next_run_at).toBeNull();
    const errDir = join(harness.cronDir, ".errors");
    expect(existsSync(errDir)).toBe(true);
    const sentinels = readdirSync(errDir);
    expect(sentinels.length).toBe(1);
    expect(sentinels[0]).toContain("one-time_gone-md");

    // Parked: subsequent ticks stay silent — one warn, no re-parse spam.
    const warnsBefore = logs.filter((l) => l.includes("grace")).length;
    await tickOnce(ctx2, at(30, 1));
    await tickOnce(ctx2, at(31));
    expect(logs.filter((l) => l.includes("grace")).length).toBe(warnsBefore);
    expect(harness.spawns).toHaveLength(0);
  });
});

describe("daemon tickOnce — unreadable cron dir (A2)", () => {
  test("readdir failure skips the whole sync — no mass tombstone, no re-fire stampede", async () => {
    if (process.getuid?.() === 0) return; // chmod 000 is no barrier to root
    writeJob("a.md", mdJob("5m"));
    writeJob("b.md", mdJob("1h"));
    await tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(2);

    chmodSync(harness.cronDir, 0o000);
    try {
      await tickOnce(harness.ctx, at(0, 1));
    } finally {
      chmodSync(harness.cronDir, 0o755);
    }
    // Nothing deleted, schedules intact.
    expect(jobRow(harness.db, "a-md").state).toBe("active");
    expect(jobRow(harness.db, "b-md").state).toBe("active");
    expect(jobRow(harness.db, "a-md").next_run_at).toBe(at(5).toISOString());

    // Readable again: no re-upsert-as-new stampede — nothing is due.
    await tickOnce(harness.ctx, at(0, 2));
    expect(harness.spawns).toHaveLength(2);
  });

  test("genuinely missing cron dir (ENOENT) still tombstones normally", async () => {
    writeJob("a.md", mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    rmSync(harness.cronDir, { recursive: true, force: true });
    await tickOnce(harness.ctx, at(0, 1));
    expect(jobRow(harness.db, "a-md").state).toBe("deleted");
  });
});

describe("daemon tickOnce — run request with missing file (A5)", () => {
  test("claimed request whose job file is gone gets expired, not stuck in-flight", async () => {
    writeJob("hello.md", mdJob("1h"));
    await tickOnce(harness.ctx, T0);
    expect(harness.spawns).toHaveLength(1);

    const jobId = (await harness.store.getJobIdBySlug("hello-md"))!;
    const reqId = await harness.store.insertRunRequest(jobId);
    // Ledger row loses its file_path (e.g. legacy row) — unspawnable.
    harness.db
      .prepare("UPDATE cron_jobs SET file_path = NULL WHERE id = $id")
      .run({ $id: jobId });

    await tickOnce(harness.ctx, at(0, 1));
    expect(harness.spawns).toHaveLength(1); // never spawned
    const req = (await harness.store.getRunRequest(reqId))!;
    expect(req.picked_up_at).not.toBeNull();
    expect(req.expired_at).not.toBeNull(); // terminal, visibly dead
  });
});

describe("daemon mutual exclusion — stale-lock hardening (A3/A4)", () => {
  test("pid-reuse: alive holder with no matching heartbeat and an old lock is taken over", async () => {
    const lock = daemonLockPath(harness.root);
    mkdirSync(join(harness.root, ".cronfish"), { recursive: true });
    // process.pid is alive but has never beaten this db's heartbeat — a
    // recycled pid, not a daemon. Age the lock past the stale window.
    writeFileSync(lock, String(process.pid), "utf-8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);

    const r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(true);
    expect(readFileSync(lock, "utf-8").trim()).toBe("4242");
    // Atomic takeover leaves no temp droppings.
    const leftovers = readdirSync(join(harness.root, ".cronfish")).filter(
      (f) => f.endsWith(".tmp"),
    );
    expect(leftovers).toHaveLength(0);
  });

  test("alive holder that IS ticking (heartbeat pid matches, recent) refuses even with an old lock", async () => {
    const lock = daemonLockPath(harness.root);
    mkdirSync(join(harness.root, ".cronfish"), { recursive: true });
    writeFileSync(lock, String(process.pid), "utf-8");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    // Tick 60s old: stale for the phase-1 fresh check (10s) but well inside
    // the 120s "still a ticking daemon" window for the lock cross-check.
    await harness.store.beatDaemonHeartbeat({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    harness.db
      .prepare("UPDATE cron_daemon_heartbeat SET last_tick_at = $t")
      .run({ $t: new Date(Date.now() - 60_000).toISOString() });

    const r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`pid ${process.pid}`);
  });

  test("a young lock from an alive pid refuses — a just-started daemon has not beaten yet", async () => {
    const lock = daemonLockPath(harness.root);
    mkdirSync(join(harness.root, ".cronfish"), { recursive: true });
    writeFileSync(lock, String(process.pid), "utf-8"); // fresh mtime
    const r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(false);
  });

  test("EPERM-guarded pid (pid 1) counts as ALIVE, not dead", async () => {
    const lock = daemonLockPath(harness.root);
    mkdirSync(join(harness.root, ".cronfish"), { recursive: true });
    writeFileSync(lock, "1", "utf-8"); // launchd/init — kill(1,0) → EPERM
    const r = await acquireDaemonExclusivity(harness.store, harness.root, 4242);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pid 1");
  });
});

describe("daemon tickOnce — post-restore thundering-herd jitter (CAD-700)", () => {
  // Craft a restored-from-backup db: job rows whose next_run_at is stale in
  // the past, plus an ancient heartbeat from the pre-restore daemon. Returns a
  // fresh ctx (a new process — startupJitterApplied unset) over the same db.
  async function seedRestore(slugs: string[], staleNextRun: Date): Promise<DaemonCtx> {
    for (const s of slugs) writeJob(`${s}.md`, mdJob("5m"));
    await tickOnce(harness.ctx, T0); // create rows + first dispatch
    harness.spawns.length = 0;
    // Every job overdue by way more than the catch-up grace.
    harness.db
      .prepare("UPDATE cron_jobs SET next_run_at = $n WHERE state = 'active'")
      .run({ $n: staleNextRun.toISOString() });
    // Ancient heartbeat rode in with the backup (pre-restore pid, old tick).
    await harness.store.beatDaemonHeartbeat({
      pid: 111,
      startedAt: at(-2000).toISOString(),
    });
    harness.db
      .prepare("UPDATE cron_daemon_heartbeat SET last_tick_at = $t")
      .run({ $t: at(-2000).toISOString() }); // ~33h before T0 → clearly stale
    return { ...harness.ctx, startupJitterApplied: undefined };
  }

  test("restore: overdue interval jobs are staggered, not fired all at once", async () => {
    const slugs = ["a", "b", "c", "d"];
    const ctx2 = await seedRestore(slugs, at(-30)); // 30m overdue

    // First tick after the "restore": only the single most-overdue job fires;
    // the other three are pushed into the jitter window.
    await tickOnce(ctx2, at(0, 1));
    expect(harness.spawns).toHaveLength(1);
    expect(harness.spawns[0]!.trigger).toBe("catchup");

    // The three deferred jobs sit at future next_run_ats inside the ~3-minute
    // jitter window (the one that fired advanced to now+5m, outside it).
    const deferred = slugs
      .map((s) => Date.parse(jobRow(harness.db, `${s}-md`).next_run_at as string))
      .map((t) => t - at(0, 1).getTime())
      .filter((delta) => delta > 0 && delta <= 3 * 60_000)
      .sort((x, y) => x - y);
    expect(deferred).toHaveLength(3);
    // Evenly spaced, strictly staggered — no two share a slot.
    expect(new Set(deferred).size).toBe(3);

    // Marching the clock forward drains them one at a time, never in a burst.
    await tickOnce(ctx2, at(3, 1)); // past the whole window
    expect(harness.spawns.length).toBe(4);
    // And no re-herd on the next tick.
    await tickOnce(ctx2, at(3, 2));
    expect(harness.spawns.length).toBe(4);
  });

  test("a lone overdue job on cold start still fires immediately (no herd)", async () => {
    const ctx2 = await seedRestore(["solo"], at(-30));
    await tickOnce(ctx2, at(0, 1));
    expect(harness.spawns).toHaveLength(1);
    expect(jobRow(harness.db, "solo-md").next_run_at).toBe(at(5, 1).toISOString());
  });

  test("a fresh heartbeat (quick restart) does NOT stagger — jobs fire at once", async () => {
    for (const s of ["a", "b", "c"]) writeJob(`${s}.md`, mdJob("5m"));
    await tickOnce(harness.ctx, T0);
    harness.spawns.length = 0;
    harness.db
      .prepare("UPDATE cron_jobs SET next_run_at = $n WHERE state = 'active'")
      .run({ $n: at(-30).toISOString() });
    // Heartbeat only ~2s stale — a quick bounce, not a cold start.
    await harness.store.beatDaemonHeartbeat({ pid: 111, startedAt: T0.toISOString() });
    harness.db
      .prepare("UPDATE cron_daemon_heartbeat SET last_tick_at = $t")
      .run({ $t: at(0, 1).toISOString() });
    const ctx2 = { ...harness.ctx, startupJitterApplied: undefined };
    await tickOnce(ctx2, at(0, 3));
    expect(harness.spawns.length).toBe(3); // all fire, no staggering
  });

  test("fresh db first-sight of many jobs is unaffected (next_run=now, not overdue)", async () => {
    for (const s of ["a", "b", "c", "d"]) writeJob(`${s}.md`, mdJob("5m"));
    // Cold start (no heartbeat) but first-sight next_run=now is not overdue
    // past the grace, so nothing is staggered — all dispatch on tick 1.
    await tickOnce(harness.ctx, T0);
    expect(harness.spawns.length).toBe(4);
  });
});

describe("daemon tickOnce — heartbeat", () => {
  test("beats every tick and counts ticks for the same process", async () => {
    await tickOnce(harness.ctx, T0);
    await tickOnce(harness.ctx, at(0, 1));
    await tickOnce(harness.ctx, at(0, 2));
    const hb = (await harness.store.getDaemonHeartbeat())!;
    expect(hb.pid).toBe(4242);
    expect(hb.tick_count).toBe(3);
    expect(hb.version).toBe("test");
    expect(Date.parse(hb.last_tick_at)).toBeGreaterThan(0);
  });
});
