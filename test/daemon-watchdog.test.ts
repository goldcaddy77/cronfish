// In-daemon missed-run detection (the folded-in watchdog): the daemon alerts
// on a job that should have run while the daemon itself was LIVE, dedupes via
// cron_missed_alerts, and stays quiet about misses that fall in its own
// downtime (the catch-up dispatch owns those).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMissedRuns, type DaemonCtx } from "../src/daemon.ts";
import { openStore } from "../src/store/index.ts";

let root: string;
let sentinel: string;
let ctx: DaemonCtx;

function minutesAgo(m: number): Date {
  return new Date(Date.now() - m * 60_000);
}

// A 5m job whose last success is 30 minutes old — well past the 10-minute
// grace floor. expected next fire = lastOk + 5m = 25 minutes ago.
async function seedOverdueJob(): Promise<void> {
  writeFileSync(
    join(root, "cron", "demo.md"),
    `---\nschedule: "5m"\nenabled: true\n---\nhi`,
  );
  const store = ctx.store;
  await store.upsertJob({
    slug: "demo-md",
    path: join(root, "cron", "demo.md"),
    kind: "md",
    enabled: true,
    schedule: "5m",
  });
  const jobId = (await store.getJobIdBySlug("demo-md"))!;
  const inv = await store.startInvocation(jobId, "schedule", "/log/1");
  const lastOk = minutesAgo(30).toISOString();
  store
    .rawHandleForTests()
    .prepare(
      "UPDATE cron_invocations SET started_at = $s, finished_at = $s, status = 'ok', exit_code = 0 WHERE id = $id",
    )
    .run({ $s: lastOk, $id: inv });
}

beforeEach(async () => {
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
  const store = await openStore(root);
  ctx = {
    store,
    consumerRoot: root,
    cronDir: join(root, "cron"),
    spawn: () => {},
    pid: 4242,
    startedAt: minutesAgo(40).toISOString(), // live for the whole window
    version: "test",
    log: () => {},
  };
});

afterEach(async () => {
  await ctx.store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("daemon checkMissedRuns", () => {
  test("daemon live through the window → alert fired once, deduped after", async () => {
    await seedOverdueJob();

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

  test("expected fire fell in a daemon-down window → no false alert (inside the post-restart grace)", async () => {
    await seedOverdueJob();
    // Daemon (re)started 2 minutes ago; the miss (25m ago) predates it —
    // catch-up dispatch gets a grace window (10m for a 5m job) from startup
    // to make the run happen, so the watchdog stays quiet for now.
    ctx.startedAt = minutesAgo(2).toISOString();

    const decisions = await checkMissedRuns(ctx, new Date());
    expect(decisions.find((d) => d.slug === "demo-md")?.outcome).toBe(
      "skipped-down-window",
    );
    expect(existsSync(sentinel)).toBe(false);
  });

  test("pre-restart miss still unresolved past the post-restart grace → alert fires (restarts delay, never mute)", async () => {
    await seedOverdueJob();
    // Miss (25m ago) predates liveSince (15m ago), but the daemon has now
    // been live for 15m — past the 10m grace — and the run still never
    // happened. A restart must not permanently mute this fault.
    ctx.startedAt = minutesAgo(15).toISOString();

    const decisions = await checkMissedRuns(ctx, new Date());
    expect(decisions.find((d) => d.slug === "demo-md")?.outcome).toBe("fired");
    expect(readFileSync(sentinel, "utf-8").trim()).toBe("demo-md");

    // A SECOND restart re-runs the check with a fresh liveSince — the dedup
    // row (not the down-window skip) is what keeps it quiet now.
    ctx.startedAt = minutesAgo(20).toISOString();
    const again = await checkMissedRuns(ctx, new Date());
    expect(again.find((d) => d.slug === "demo-md")?.outcome).toBe(
      "skipped-already-fired",
    );
    expect(readFileSync(sentinel, "utf-8").trim()).toBe("demo-md");
  });
});
