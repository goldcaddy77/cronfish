import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getJobIdBySlug,
  openDb,
  startInvocation,
  upsertJob,
} from "../src/db.ts";
import { intervalSecondsAt, nextFireAfter } from "../src/schedule.ts";
import { decideWatchdog, runWatchdog } from "../src/watchdog.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cronfish-wd-"));
}

describe("nextFireAfter", () => {
  test("seconds schedule advances by interval", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    expect(nextFireAfter("5m", now)?.toISOString()).toBe(
      "2026-06-06T00:05:00Z".replace("Z", ".000Z"),
    );
  });
  test("cron expression honors single-int fields", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    // 15 * * * *  → next 00:15
    const t = nextFireAfter("15 * * * *", now)!;
    expect(t.getUTCMinutes()).toBe(15);
    expect(t.getUTCHours()).toBe(0);
  });
  test("manual returns null", () => {
    expect(nextFireAfter("manual", new Date())).toBeNull();
  });
});

describe("intervalSecondsAt", () => {
  test("seconds passes through", () => {
    expect(intervalSecondsAt(600, new Date())).toBe(600);
  });
  test("cron gap matches expectation", () => {
    expect(intervalSecondsAt("15 * * * *", new Date("2026-06-06T00:00:00Z"))).toBe(
      3600,
    );
  });
});

describe("decideWatchdog", () => {
  const baseNow = new Date("2026-06-06T01:00:00Z");

  test("cold-start (no successful run) → skipped-cold", () => {
    const r = decideWatchdog({
      now: baseNow,
      schedule: "5m",
      lastOk: null,
      lastMissedFiredAt: null,
      adapterConfigured: true,
    });
    expect(r.outcome).toBe("skipped-cold");
  });

  test("manual schedule → skipped-manual", () => {
    const r = decideWatchdog({
      now: baseNow,
      schedule: "manual",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: null,
      adapterConfigured: true,
    });
    expect(r.outcome).toBe("skipped-manual");
  });

  test("within grace window → skipped-on-time", () => {
    const r = decideWatchdog({
      now: new Date("2026-06-06T00:06:00Z"),
      schedule: "5m",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: null,
      adapterConfigured: true,
    });
    expect(r.outcome).toBe("skipped-on-time");
  });

  test("past grace, no prior miss → fired", () => {
    const r = decideWatchdog({
      now: new Date("2026-06-06T01:00:00Z"),
      schedule: "5m",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: null,
      adapterConfigured: true,
    });
    expect(r.outcome).toBe("fired");
    expect(r.grace_s).toBe(600);
  });

  test("already fired since last ok → skipped-already-fired", () => {
    const r = decideWatchdog({
      now: new Date("2026-06-06T01:00:00Z"),
      schedule: "5m",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: "2026-06-06T00:30:00Z",
      adapterConfigured: true,
    });
    expect(r.outcome).toBe("skipped-already-fired");
  });

  test("missed_after override honored", () => {
    const r = decideWatchdog({
      now: new Date("2026-06-06T00:34:00Z"),
      schedule: "5m",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: null,
      missedAfter: "30m",
      adapterConfigured: true,
    });
    // expected = 00:05; deadline = 00:05 + 30m = 00:35. now equals → still on-time.
    expect(r.outcome).toBe("skipped-on-time");
    expect(r.grace_s).toBe(1800);
  });

  test("missed but no adapter configured → skipped-no-adapter", () => {
    const r = decideWatchdog({
      now: new Date("2026-06-06T01:00:00Z"),
      schedule: "5m",
      lastOk: "2026-06-06T00:00:00Z",
      lastMissedFiredAt: null,
      adapterConfigured: false,
    });
    expect(r.outcome).toBe("skipped-no-adapter");
  });
});

describe("runWatchdog (integration)", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
    mkdirSync(join(root, ".cronfish"), { recursive: true });
    mkdirSync(join(root, "cron"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("fires missed alert via shell adapter and dedupes second run", async () => {
    writeFileSync(
      join(root, "cron", "demo.md"),
      `---\nschedule: "5m"\nenabled: true\n---\nhi`,
    );
    const sentinel = join(root, "sentinel.log");
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({
        alerts: {
          default: "shell",
          shell: { command: `printenv CRONFISH_ALERT_SLUG >> "${sentinel}"` },
        },
      }),
    );

    const db = openDb(root);
    upsertJob(db, {
      slug: "demo-md",
      path: join(root, "cron", "demo.md"),
      kind: "md",
      enabled: true,
      schedule: "5m",
    });
    const jobId = getJobIdBySlug(db, "demo-md")!;
    const inv = startInvocation(db, jobId, "schedule", "/log/1");
    // Successful run 30 minutes ago — well past grace.
    const lastOk = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE cron_invocations SET started_at = $s, finished_at = $s, status = 'ok', exit_code = 0 WHERE id = $id",
    ).run({ $s: lastOk, $id: inv });
    db.close();

    const first = await runWatchdog({ consumerRoot: root });
    expect(first.find((d) => d.slug === "demo-md")?.outcome).toBe("fired");

    const second = await runWatchdog({ consumerRoot: root });
    expect(second.find((d) => d.slug === "demo-md")?.outcome).toBe(
      "skipped-already-fired",
    );
  });
});
