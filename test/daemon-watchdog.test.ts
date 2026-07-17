// In-daemon missed-run detection (the folded-in watchdog): the daemon alerts
// on a job that should have run while the daemon itself was LIVE, dedupes via
// cron_missed_alerts, and stays quiet about misses that fall in its own
// downtime (the catch-up dispatch owns those).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMissedRuns, type DaemonCtx } from "../src/daemon.ts";
import {
  getJobIdBySlug,
  openDb,
  startInvocation,
  upsertJob,
} from "../src/db.ts";

let root: string;
let sentinel: string;
let ctx: DaemonCtx;

function minutesAgo(m: number): Date {
  return new Date(Date.now() - m * 60_000);
}

// A 5m job whose last success is 30 minutes old — well past the 10-minute
// grace floor. expected next fire = lastOk + 5m = 25 minutes ago.
function seedOverdueJob(): void {
  writeFileSync(
    join(root, "cron", "demo.md"),
    `---\nschedule: "5m"\nenabled: true\n---\nhi`,
  );
  const db = ctx.db;
  upsertJob(db, {
    slug: "demo-md",
    path: join(root, "cron", "demo.md"),
    kind: "md",
    enabled: true,
    schedule: "5m",
  });
  const jobId = getJobIdBySlug(db, "demo-md")!;
  const inv = startInvocation(db, jobId, "schedule", "/log/1");
  const lastOk = minutesAgo(30).toISOString();
  db.prepare(
    "UPDATE cron_invocations SET started_at = $s, finished_at = $s, status = 'ok', exit_code = 0 WHERE id = $id",
  ).run({ $s: lastOk, $id: inv });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cronfish-dwd-"));
  mkdirSync(join(root, "cron"), { recursive: true });
  sentinel = join(root, "sentinel.log");
  writeFileSync(
    join(root, ".cronfish.json"),
    JSON.stringify({
      alerts: {
        on_failure: { notify: "shell" },
        shell: { command: `printenv CRONFISH_ALERT_SLUG >> "${sentinel}"` },
      },
    }),
  );
  const db = openDb(root);
  ctx = {
    db,
    consumerRoot: root,
    cronDir: join(root, "cron"),
    spawn: () => {},
    pid: 4242,
    startedAt: minutesAgo(40).toISOString(), // live for the whole window
    version: "test",
    log: () => {},
  };
});

afterEach(() => {
  ctx.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("daemon checkMissedRuns", () => {
  test("daemon live through the window → alert fired once, deduped after", async () => {
    seedOverdueJob();

    const first = await checkMissedRuns(ctx, new Date());
    expect(first.find((d) => d.slug === "demo-md")?.outcome).toBe("fired");
    expect(readFileSync(sentinel, "utf-8").trim()).toBe("demo-md");

    const second = await checkMissedRuns(ctx, new Date());
    expect(second.find((d) => d.slug === "demo-md")?.outcome).toBe(
      "skipped-already-fired",
    );
    // Still exactly one alert.
    expect(readFileSync(sentinel, "utf-8").trim()).toBe("demo-md");
  });

  test("expected fire fell in a daemon-down window → no false alert", async () => {
    seedOverdueJob();
    // Daemon (re)started 2 minutes ago; the miss (25m ago) predates it —
    // catch-up dispatch handles it, the watchdog must stay quiet.
    ctx.startedAt = minutesAgo(2).toISOString();

    const decisions = await checkMissedRuns(ctx, new Date());
    expect(decisions.find((d) => d.slug === "demo-md")?.outcome).toBe(
      "skipped-down-window",
    );
    expect(existsSync(sentinel)).toBe(false);
  });
});
