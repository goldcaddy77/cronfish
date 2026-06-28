import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeArgs } from "../src/runner.ts";

const RUNNER = new URL("../src/runner.ts", import.meta.url).pathname;

interface SpawnResult {
  code: number;
  out: string;
  err: string;
  durationMs: number;
}

function spawnRunner(root: string, jobPath: string): SpawnResult {
  const t0 = Date.now();
  const proc = Bun.spawnSync(["bun", RUNNER, jobPath], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
    env: { ...process.env, CRONFISH_CONSUMER_ROOT: root },
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
    expect(readFileSync(join(root, "cron", ".errors", errs[0]!), "utf-8")).toContain(
      "runtime past grace",
    );
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
    proc.kill("SIGTERM");
    await proc.exited;
    expect(existsSync(lp)).toBe(false);
  }, 15_000);

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
});
