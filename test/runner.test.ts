import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  linkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeArgs,
  resolveEntrypoint,
  resolveStatus,
  LOCK_WRITE_GRACE_MS,
  tryAcquirePidLock,
} from "../src/runner.ts";
import { openStore } from "../src/store/index.ts";
import { loadJob, type JobMeta } from "../src/jobs.ts";

const RUNNER = new URL("../src/runner.ts", import.meta.url).pathname;

interface SpawnResult {
  code: number;
  out: string;
  err: string;
  durationMs: number;
}

function spawnRunner(
  root: string,
  jobPath: string,
  extraEnv: Record<string, string> = {},
): SpawnResult {
  const t0 = Date.now();
  const proc = Bun.spawnSync(["bun", RUNNER, jobPath], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
    env: { ...process.env, CRONFISH_CONSUMER_ROOT: root, ...extraEnv },
  });
  return {
    code: proc.exitCode ?? 0,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
    durationMs: Date.now() - t0,
  };
}

function writeJob(root: string, name: string, body: string): string {
  const cron = join(root, "cron");
  mkdirSync(cron, { recursive: true });
  const path = join(cron, name);
  writeFileSync(path, body, "utf-8");
  return path;
}

function latestLog(root: string, slug: string): string {
  const dir = join(root, ".cronfish", "logs", slug);
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .sort();
  if (files.length === 0) return "";
  return readFileSync(join(dir, files[files.length - 1]!), "utf-8");
}

function lockPath(root: string, slug: string): string {
  return join(root, ".cronfish", "locks", slug, "runner.pid");
}

describe("tryAcquirePidLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cronfish-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the lock holds its owner's pid the instant it exists", () => {
    const path = join(dir, "runner.pid");
    let seen: string | null = null;
    let rival: boolean | null = null;
    const got = tryAcquirePidLock(path, {
      onVisible: () => {
        // A second runner arriving right now must see a held lock, not an
        // empty file it would take for corrupt and steal.
        seen = readFileSync(path, "utf-8");
        rival = tryAcquirePidLock(path);
      },
    });
    expect(got).toBe(true);
    expect(seen).toBe(String(process.pid));
    expect(rival).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
    expect(readdirSync(dir)).toEqual(["runner.pid"]);
  });

  test("takes over a lock whose owner is gone", () => {
    const path = join(dir, "runner.pid");
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(path, String(dead));
    expect(tryAcquirePidLock(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
  });

  test("falls back to create-then-write where hard links are unsupported", () => {
    const path = join(dir, "runner.pid");
    const noLinks = (): never => {
      throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
    };
    expect(tryAcquirePidLock(path, { link: noLinks })).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
    // And it still excludes a second caller.
    expect(tryAcquirePidLock(path, { link: noLinks })).toBe(false);
    expect(readdirSync(dir)).toEqual(["runner.pid"]);
  });

  test("a fresh lock with no pid yet is held, not stolen", () => {
    // A create-then-write holder between its create and its write.
    const path = join(dir, "runner.pid");
    writeFileSync(path, "");
    const noLinks = (): never => {
      throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
    };
    expect(tryAcquirePidLock(path, { link: noLinks })).toBe(false);
    expect(tryAcquirePidLock(path)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  test("an old lock with no pid is taken over", () => {
    const path = join(dir, "runner.pid");
    writeFileSync(path, "");
    const later = () => Date.now() + LOCK_WRITE_GRACE_MS + 1000;
    expect(tryAcquirePidLock(path, { now: later })).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
  });

  test("a lock released mid-check is retried, not a crash", () => {
    const path = join(dir, "runner.pid");
    writeFileSync(path, String(process.ppid));
    let first = true;
    // The holder releases right as our link attempt fails.
    const link = (from: string, to: string): void => {
      if (first) {
        first = false;
        rmSync(to);
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      linkSync(from, to);
    };
    expect(tryAcquirePidLock(path, { link })).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
  });

  test("refuses a lock a live process holds", () => {
    const path = join(dir, "runner.pid");
    writeFileSync(path, String(process.ppid));
    expect(tryAcquirePidLock(path)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(String(process.ppid));
  });
});

describe("runner", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-runner-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("retries failing job and logs each attempt", () => {
    const counter = join(root, "counter.txt");
    const job = writeJob(
      root,
      "fail.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  retries: 1,
  timeout: 30,
};
export default async function run() {
  const fs = await import("node:fs");
  fs.appendFileSync(${JSON.stringify(counter)}, "x");
  process.exit(1);
}
`,
    );
    const r = spawnRunner(root, job);
    expect(r.code).toBe(1);
    const runs = readFileSync(counter, "utf-8").length;
    expect(runs).toBe(2); // initial + 1 retry
    const log = latestLog(root, "fail-ts");
    expect(log).toContain("retry 1/1");
    expect(log).toContain("exit=1");
  }, 20_000);

  test("one-time fired past grace is refused, not run, and writes a sentinel", () => {
    const sentinel = join(root, "ran.txt");
    const oneTime = join(root, "cron", "one-time");
    mkdirSync(oneTime, { recursive: true });
    const job = join(oneTime, "expired.ts");
    writeFileSync(
      job,
      `export const config = { run_at: "2020-01-01T00:00:00Z", enabled: true };
export default async function run() {
  const fs = await import("node:fs");
  fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");
}
`,
      "utf-8",
    );
    const r = spawnRunner(root, job);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("past grace");
    expect(existsSync(sentinel)).toBe(false); // job body never ran
    const errs = readdirSync(join(root, "cron", ".errors")).filter((f) =>
      f.endsWith(".txt"),
    );
    expect(errs).toHaveLength(1);
    expect(
      readFileSync(join(root, "cron", ".errors", errs[0]!), "utf-8"),
    ).toContain("runtime past grace");
  });

  test("concurrency=skip with live lock exits 0 without running", () => {
    const sentinel = join(root, "ran.txt");
    const job = writeJob(
      root,
      "skip.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  concurrency: "skip",
  timeout: 5,
};
export default async function run() {
  const fs = await import("node:fs");
  fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");
}
`,
    );
    // Pre-create lock pointing at this test process (definitely alive).
    const lp = lockPath(root, "skip-ts");
    mkdirSync(join(root, ".cronfish", "locks", "skip-ts"), { recursive: true });
    writeFileSync(lp, String(process.pid), "utf-8");
    const r = spawnRunner(root, job);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("concurrency=skip");
    expect(existsSync(sentinel)).toBe(false);
    // Pre-existing lock left in place — runner did not claim it.
    expect(readFileSync(lp, "utf-8")).toBe(String(process.pid));
  });

  test("stale PID lock is claimed and job runs", () => {
    const sentinel = join(root, "ran.txt");
    const job = writeJob(
      root,
      "stale.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  concurrency: "skip",
  timeout: 5,
};
export default async function run() {
  const fs = await import("node:fs");
  fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");
}
`,
    );
    // Find a definitively dead PID by spawning sleep 0 and reading its pid.
    const dead = Bun.spawnSync(["true"]);
    const deadPid = dead.pid;
    mkdirSync(join(root, ".cronfish", "locks", "stale-ts"), {
      recursive: true,
    });
    writeFileSync(lockPath(root, "stale-ts"), String(deadPid), "utf-8");
    const r = spawnRunner(root, job);
    expect(r.code).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    // Runner released its own lock on exit.
    expect(existsSync(lockPath(root, "stale-ts"))).toBe(false);
  });

  test("SIGTERM releases the lock", async () => {
    const job = writeJob(
      root,
      "long.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  concurrency: "skip",
  timeout: 60,
};
export default async function run() {
  await new Promise(r => setTimeout(r, 30_000));
}
`,
    );
    const proc = Bun.spawn(["bun", RUNNER, job], {
      stdout: "ignore",
      stderr: "ignore",
      cwd: root,
      env: { ...process.env, CRONFISH_CONSUMER_ROOT: root },
    });
    // Wait for lock to appear.
    const lp = lockPath(root, "long-ts");
    const deadline = Date.now() + 5000;
    while (!existsSync(lp) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(existsSync(lp)).toBe(true);
    // The lock is never visible without its owner's pid in it.
    expect(readFileSync(lp, "utf-8")).toBe(String(proc.pid));
    proc.kill("SIGTERM");
    await proc.exited;
    expect(existsSync(lp)).toBe(false);
    // No staging file is left beside it.
    expect(readdirSync(join(root, ".cronfish", "locks", "long-ts"))).toEqual(
      [],
    );
  }, 15_000);

  test("SIGTERM while queued for the lock leaves the holder's lock alone", async () => {
    const job = writeJob(
      root,
      "queued.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  concurrency: "queue",
  timeout: 60,
};
export default async function run() {}
`,
    );
    // Another live process (this test runner) holds the lock.
    const lp = lockPath(root, "queued-ts");
    mkdirSync(join(root, ".cronfish", "locks", "queued-ts"), {
      recursive: true,
    });
    writeFileSync(lp, String(process.pid));
    const proc = Bun.spawn(["bun", RUNNER, job], {
      stdout: "ignore",
      stderr: "ignore",
      cwd: root,
      env: { ...process.env, CRONFISH_CONSUMER_ROOT: root },
    });
    // Let the runner reach the lock wait, then stop it there.
    await Bun.sleep(1500);
    proc.kill("SIGTERM");
    const code = await proc.exited;
    expect(code).toBe(143);
    expect(readFileSync(lp, "utf-8")).toBe(String(process.pid));
  }, 15_000);

  test("daemon env: links the run request, records scheduled_for, stamps last_run", async () => {
    const job = writeJob(
      root,
      "linked.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  timeout: 30,
};
export default async function run() {
  console.log("[linked] ran");
}
`,
    );
    // The daemon seeds the job row + run request before spawning the runner.
    const cronDir = join(root, "cron");
    const seed = await openStore(root);
    await seed.upsertJob(loadJob(job, undefined, cronDir));
    const jobId = (await seed.getJobIdBySlug("linked-ts"))!;
    const reqId = await seed.insertRunRequest(jobId);
    await seed.close();

    const scheduledFor = "2026-07-17T12:00:00.000Z";
    const r = spawnRunner(root, job, {
      CRONFISH_TRIGGER: "manual",
      CRONFISH_RUN_REQUEST_ID: String(reqId),
      CRONFISH_SCHEDULED_FOR: scheduledFor,
    });
    expect(r.code).toBe(0);

    const store = await openStore(root);
    const db = store.rawHandleForTests();
    const req = (await store.getRunRequest(reqId))!;
    expect(req.invocation_id).not.toBeNull();
    const inv = db
      .query(
        "SELECT trigger, scheduled_for, status FROM cron_invocations WHERE id = $id",
      )
      .get({ $id: req.invocation_id }) as {
      trigger: string;
      scheduled_for: string | null;
      status: string;
    };
    expect(inv.trigger).toBe("manual");
    expect(inv.scheduled_for).toBe(scheduledFor);
    expect(inv.status).toBe("ok");
    const jobRow = db
      .query(
        "SELECT last_run_at, last_status FROM cron_jobs WHERE slug = 'linked-ts'",
      )
      .get() as { last_run_at: string | null; last_status: string | null };
    expect(jobRow.last_run_at).not.toBeNull();
    expect(jobRow.last_status).toBe("ok");
    await store.close();
  }, 20_000);

  test("runs a .sh job and captures stdout to the log", () => {
    const sentinel = join(root, "ran.txt");
    const job = writeJob(
      root,
      "hello.sh",
      `#!/bin/bash
# ---
# schedule: manual
# enabled: true
# timeout: 10
# ---
echo hello-from-sh
touch ${JSON.stringify(sentinel)}
`,
    );
    const r = spawnRunner(root, job);
    expect(r.code).toBe(0);
    expect(existsSync(sentinel)).toBe(true);
    const log = latestLog(root, "hello-sh");
    expect(log).toContain("kind=sh");
    expect(log).toContain("hello-from-sh");
    expect(log).toContain("exit=0");
  }, 15_000);

  test("timeout kills the child and reports 124", () => {
    const job = writeJob(
      root,
      "slow.ts",
      `export const config = {
  schedule: "manual",
  enabled: true,
  timeout: 1,
};
export default async function run() {
  await new Promise(r => setTimeout(r, 10_000));
}
`,
    );
    const r = spawnRunner(root, job);
    expect(r.code).toBe(124);
    // Should complete well under the 10s sleep.
    expect(r.durationMs).toBeLessThan(8_000);
    const log = latestLog(root, "slow-ts");
    expect(log).toContain("timeout after 1s");
  }, 15_000);
});

describe("runner — reported result decides status", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-result-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Runs a .sh job that prints `body` and exits with `code`, then returns the
  // ledger row the runner wrote for it.
  async function runShJob(name: string, body: string, code = 0) {
    const job = writeJob(
      root,
      `${name}.sh`,
      `#!/bin/bash
# ---
# schedule: manual
# enabled: true
# timeout: 10
# ---
${body}
exit ${code}
`,
    );
    const r = spawnRunner(root, job, { CRONFISH_TRIGGER: "manual" });
    const store = await openStore(root);
    const inv = store
      .rawHandleForTests()
      .query(
        `SELECT i.status, i.exit_code, i.result_ok, i.result_summary, j.last_status
           FROM cron_invocations i JOIN cron_jobs j ON j.id = i.job_id
          WHERE j.slug = $slug ORDER BY i.id DESC LIMIT 1`,
      )
      .get({ $slug: `${name}-sh` }) as {
      status: string;
      exit_code: number;
      result_ok: number | null;
      result_summary: string | null;
      last_status: string;
    };
    await store.close();
    return { r, inv, log: latestLog(root, `${name}-sh`) };
  }

  const sentinel = (o: object) =>
    `echo '__CRONFISH_RESULT_V1__::${JSON.stringify(o)}'`;

  test("exit 0 with ok:false is recorded as a failure, with the reason", async () => {
    const { r, inv, log } = await runShJob(
      "softfail",
      sentinel({ summary: "upstream rejected 3 items", ok: false }),
    );
    expect(r.code).toBe(0);
    expect(inv.status).toBe("fail");
    expect(inv.last_status).toBe("fail");
    expect(inv.exit_code).toBe(0);
    expect(inv.result_ok).toBe(0);
    expect(inv.result_summary).toBe("upstream rejected 3 items");
    expect(log).toContain('job reported ok=false: "upstream rejected 3 items"');
  }, 20_000);

  test("exit 0 with ok:true is ok", async () => {
    const { inv } = await runShJob(
      "softok",
      sentinel({ summary: "all good", ok: true }),
    );
    expect(inv.status).toBe("ok");
    expect(inv.last_status).toBe("ok");
  }, 20_000);

  test("exit 0 with a result that has no ok field is ok", async () => {
    const { inv } = await runShJob(
      "nook",
      sentinel({ summary: "no verdict given" }),
    );
    expect(inv.status).toBe("ok");
  }, 20_000);

  test("exit 0 with no parsed result is ok", async () => {
    const { inv } = await runShJob("noresult", "echo just some output");
    expect(inv.status).toBe("ok");
    expect(inv.result_summary).toBeNull();
  }, 20_000);

  test("exit 0 with malformed result output is ok", async () => {
    const { inv } = await runShJob(
      "badresult",
      `echo '__CRONFISH_RESULT_V1__::{not json'`,
    );
    expect(inv.status).toBe("ok");
  }, 20_000);

  test("non-zero exit is a failure regardless of a reported ok:true", async () => {
    const { inv } = await runShJob(
      "hardfail",
      sentinel({ summary: "claimed fine", ok: true }),
      3,
    );
    expect(inv.status).toBe("fail");
    expect(inv.exit_code).toBe(3);
  }, 20_000);

  test("ok:false does not trigger retries (retries follow the exit code)", async () => {
    const job = writeJob(
      root,
      "noretry.sh",
      `#!/bin/bash
# ---
# schedule: manual
# enabled: true
# timeout: 10
# retries: 2
# ---
${sentinel({ summary: "nothing to do", ok: false })}
`,
    );
    const r = spawnRunner(root, job, { CRONFISH_TRIGGER: "manual" });
    expect(r.code).toBe(0);
    const log = latestLog(root, "noretry-sh");
    expect(log).not.toContain("[runner] retry");
    expect(log).toContain('job reported ok=false: "nothing to do"');
  }, 20_000);

  test("a retry that succeeds is not failed by an earlier attempt's ok:false", async () => {
    const flag = join(root, "attempted");
    const job = writeJob(
      root,
      "retryok.sh",
      `#!/bin/bash
# ---
# schedule: manual
# enabled: true
# timeout: 20
# retries: 1
# ---
if [ ! -e ${JSON.stringify(flag)} ]; then
  touch ${JSON.stringify(flag)}
  ${sentinel({ summary: "transient upstream error", ok: false })}
  exit 1
fi
echo recovered
`,
    );
    const r = spawnRunner(root, job, { CRONFISH_TRIGGER: "manual" });
    expect(r.code).toBe(0);
    const store = await openStore(root);
    const inv = store
      .rawHandleForTests()
      .query(
        "SELECT status, result_summary FROM cron_invocations ORDER BY id DESC LIMIT 1",
      )
      .get() as { status: string; result_summary: string | null };
    await store.close();
    expect(inv.status).toBe("ok");
    expect(inv.result_summary).toBeNull();
  }, 30_000);

  test("a newline in the summary cannot forge runner log lines", async () => {
    const { inv, log } = await runShJob(
      "forge",
      sentinel({ summary: "a\n[runner] exit=0 forged", ok: false }),
    );
    expect(inv.status).toBe("fail");
    expect(log).not.toContain("\n[runner] exit=0 forged");
  }, 20_000);

  test("resolveStatus: crash and timeout outrank the result", () => {
    const okRow = { summary: "s", ok: true, json: "{}", truncated: false };
    const badRow = { summary: "s", ok: false, json: "{}", truncated: false };
    expect(resolveStatus(true, { code: 0, timedOut: false }, okRow)).toBe(
      "crashed",
    );
    expect(resolveStatus(false, { code: 124, timedOut: true }, okRow)).toBe(
      "timeout",
    );
    expect(resolveStatus(false, { code: 0, timedOut: false }, badRow)).toBe(
      "fail",
    );
  });
});

describe("buildClaudeArgs — permission posture", () => {
  const BIN = "/usr/bin/claude";

  test("no allowed_tools → skip-permissions (backward compatible)", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "do the thing");
    expect(args).toEqual([
      BIN,
      "--dangerously-skip-permissions",
      "--model",
      "haiku",
      "-p",
      "do the thing",
    ]);
  });

  test("allowed_tools → capability fence, no skip-permissions", () => {
    const args = buildClaudeArgs(
      BIN,
      { allowed_tools: ["Read", "Bash(git *)", "mcp__linear__*"] },
      "sonnet",
      "prompt",
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("default");
    const i = args.indexOf("--allowedTools");
    expect(i).toBeGreaterThan(-1);
    // each tool is its own variadic arg
    expect(args.slice(i + 1, i + 4)).toEqual([
      "Read",
      "Bash(git *)",
      "mcp__linear__*",
    ]);
    expect(args).toContain("--model");
    expect(args[args.length - 2]).toBe("-p");
    expect(args[args.length - 1]).toBe("prompt");
  });

  test("empty allowed_tools [] still fences (denies everything off-list)", () => {
    const args = buildClaudeArgs(BIN, { allowed_tools: [] }, "haiku", "p");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--allowedTools");
  });

  test("max_cost adds --max-budget-usd", () => {
    const args = buildClaudeArgs(BIN, { max_cost: 0.5 }, "haiku", "p");
    const i = args.indexOf("--max-budget-usd");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("0.5");
  });

  test("no max_cost omits the budget flag", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "p");
    expect(args).not.toContain("--max-budget-usd");
  });

  test("max_cost composes with the permission fence", () => {
    const args = buildClaudeArgs(
      BIN,
      { allowed_tools: ["Read"], max_cost: 2 },
      "haiku",
      "p",
    );
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--max-budget-usd");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("read_only denies the mutating built-ins", () => {
    const args = buildClaudeArgs(BIN, { read_only: true }, "haiku", "p");
    const i = args.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    expect(args.slice(i + 1, i + 5)).toEqual([
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash",
    ]);
    // read_only alone keeps the skip-permissions default for everything else
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("read_only composes with the allowlist (deny + allow both present)", () => {
    const args = buildClaudeArgs(
      BIN,
      { allowed_tools: ["Read", "mcp__linear__*"], read_only: true },
      "haiku",
      "p",
    );
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--disallowedTools");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("no read_only omits the deny flag", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "p");
    expect(args).not.toContain("--disallowedTools");
  });

  test("appendSystemPrompt injects --append-system-prompt before -p", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "body", "SYSTEM PRELUDE");
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("SYSTEM PRELUDE");
    // The prelude precedes --model ... -p, so it prepends the job body.
    expect(i).toBeLessThan(args.indexOf("--model"));
    expect(args[args.length - 2]).toBe("-p");
    expect(args[args.length - 1]).toBe("body");
  });

  test("no appendSystemPrompt omits the flag (backward compatible)", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "p");
    expect(args).not.toContain("--append-system-prompt");
  });

  test("empty appendSystemPrompt omits the flag", () => {
    const args = buildClaudeArgs(BIN, {}, "haiku", "p", "");
    expect(args).not.toContain("--append-system-prompt");
  });

  test("appendSystemPrompt composes with the capability fence", () => {
    const args = buildClaudeArgs(
      BIN,
      { allowed_tools: ["Read"] },
      "haiku",
      "p",
      "PRELUDE",
    );
    expect(args).toContain("--allowedTools");
    const i = args.indexOf("--append-system-prompt");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(args.indexOf("--model"));
  });
});

describe("resolveEntrypoint — claude.entrypoint_command", () => {
  let root: string;
  let fd: number;
  const prevConsumerRoot = process.env.CRONFISH_CONSUMER_ROOT;
  const job = (entrypoint?: boolean) => ({ entrypoint }) as JobMeta;
  const configure = (command: string) =>
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ claude: { entrypoint_command: command } }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-ep-"));
    process.env.CRONFISH_CONSUMER_ROOT = root;
    fd = openSync(join(root, "run.log"), "a");
  });
  afterEach(() => {
    closeSync(fd);
    if (prevConsumerRoot === undefined)
      delete process.env.CRONFISH_CONSUMER_ROOT;
    else process.env.CRONFISH_CONSUMER_ROOT = prevConsumerRoot;
    rmSync(root, { recursive: true, force: true });
  });

  test("returns the command's trimmed stdout", () => {
    configure("printf '  PRELUDE\\n  '");
    expect(resolveEntrypoint(job(), fd)).toBe("PRELUDE");
  });

  test("entrypoint: false opts the job out even when configured", () => {
    configure("echo SHOULD_NOT_RUN");
    expect(resolveEntrypoint(job(false), fd)).toBeUndefined();
  });

  test("undefined entrypoint still applies the command (default on)", () => {
    configure("echo ON_BY_DEFAULT");
    expect(resolveEntrypoint(job(undefined), fd)).toBe("ON_BY_DEFAULT");
  });

  test("no config → undefined", () => {
    expect(resolveEntrypoint(job(), fd)).toBeUndefined();
  });

  test("non-zero exit → undefined (non-blocking)", () => {
    configure("echo partial; exit 3");
    expect(resolveEntrypoint(job(), fd)).toBeUndefined();
  });

  test("empty output → undefined", () => {
    configure("true");
    expect(resolveEntrypoint(job(), fd)).toBeUndefined();
  });
});
