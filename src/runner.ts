#!/usr/bin/env bun
// Cronfish runner. Invoked by launchd as:
//   /usr/bin/env bun <runner.ts> <abs-path-to-job-file>
//
// Bun auto-loads .env from cwd (set to consumer root via plist
// WorkingDirectory), so no shell pre-step is needed.
//
// Per-run log: <consumer>/.cronfish/logs/<slug>/<invocation-id>.log
// Concurrency lock: <consumer>/.cronfish/locks/<slug>/runner.pid (atomic O_EXCL).
// Ledger DB: <consumer>/.cronfish/db.sqlite (failure-safe — DB errors warn
// once and never block the run).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  finishInvocation,
  getJobIdBySlug,
  openDb,
  startInvocation,
  upsertJob,
  type InvocationStatus,
  type InvocationTrigger,
} from "./db.ts";
import { loadJob, slugFromPath, type JobMeta } from "./jobs.ts";
import { resolveModel, localCommand } from "./models.ts";

const DEFAULT_TIMEOUT_S = 300;
const LOCK_POLL_MS = 2_000;
const KILL_GRACE_MS = 5_000;

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  join(process.env.HOME ?? "", ".local", "bin", "claude");

function consumerRoot(): string {
  return process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
}

function logsJobDir(slug: string): string {
  const dir = join(consumerRoot(), ".cronfish", "logs", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function locksJobDir(slug: string): string {
  const dir = join(consumerRoot(), ".cronfish", "locks", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function logPathFor(slug: string, invocationId: number | "preinit"): string {
  return join(logsJobDir(slug), `${invocationId}.log`);
}

function appendLog(fd: number, msg: string): void {
  writeSync(fd, msg.endsWith("\n") ? msg : msg + "\n");
}

function warn(msg: string): void {
  console.error(`[runner] WARN: ${msg}`);
}

// --- Concurrency lock (atomic create-or-fail) ---

function lockPath(slug: string): string {
  return join(locksJobDir(slug), "runner.pid");
}

function tryAcquireLock(slug: string): boolean {
  const path = lockPath(slug);
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    if (!existsSync(path)) return false;
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (Number.isNaN(pid)) {
      safeRm(path);
      return tryAcquireLock(slug);
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      safeRm(path);
      return tryAcquireLock(slug);
    }
  }
}

function releaseLock(slug: string): void {
  safeRm(lockPath(slug));
}

function safeRm(path: string): void {
  try {
    rmSync(path);
  } catch {}
}

async function waitForLock(
  slug: string,
  mode: "skip" | "queue",
  timeoutS: number,
): Promise<boolean> {
  if (tryAcquireLock(slug)) return true;
  if (mode === "skip") return false;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(LOCK_POLL_MS);
    if (tryAcquireLock(slug)) return true;
  }
  return false;
}

// --- Spawn helpers ---

interface SpawnSpec {
  cmd: string[];
  cwd: string;
  stdin?: "ignore" | "pipe";
  stdinPayload?: string;
}

interface SpawnResult {
  code: number;
  timedOut: boolean;
}

async function runSpawn(
  spec: SpawnSpec,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  const proc = Bun.spawn(spec.cmd, {
    cwd: spec.cwd,
    stdout: fd,
    stderr: fd,
    stdin: spec.stdin ?? "ignore",
    // @ts-expect-error — Bun supports detached on spawn options
    detached: true,
  });
  if (spec.stdin === "pipe" && spec.stdinPayload && proc.stdin) {
    const writer = proc.stdin as unknown as {
      write: (s: string) => void;
      end: () => void;
    };
    writer.write(spec.stdinPayload);
    writer.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    appendLog(
      fd,
      `\n[runner] timeout after ${timeoutS}s — killing process group`,
    );
    killTree(proc.pid);
  }, timeoutS * 1000);

  const code = await proc.exited;
  clearTimeout(timer);
  return { code: timedOut ? 124 : code, timedOut };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }, KILL_GRACE_MS).unref?.();
}

// --- Per-kind execution ---

async function execMarkdown(
  job: JobMeta,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  const raw = await Bun.file(job.path).text();
  const { parseFrontmatter } = await import("./frontmatter.ts");
  const { body } = parseFrontmatter(raw);
  const model = resolveModel(job.model);
  const prompt = body.trim();
  appendLog(
    fd,
    `[runner] kind=md model=${model.provider}:${model.id} timeout=${timeoutS}s`,
  );
  if (model.provider === "anthropic") {
    return runSpawn(
      {
        cmd: [
          CLAUDE_BIN,
          "--dangerously-skip-permissions",
          "--model",
          model.id,
          "-p",
          prompt,
        ],
        cwd: consumerRoot(),
      },
      fd,
      timeoutS,
    );
  }
  const { cmd, stdin } = localCommand(model.id, prompt);
  return runSpawn(
    { cmd, cwd: consumerRoot(), stdin: "pipe", stdinPayload: stdin },
    fd,
    timeoutS,
  );
}

async function execTypescript(
  job: JobMeta,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  const shim = resolve(import.meta.dir, "ts-shim.ts");
  appendLog(fd, `[runner] kind=ts file=${job.path} timeout=${timeoutS}s`);
  return runSpawn(
    { cmd: ["bun", shim, job.path], cwd: consumerRoot() },
    fd,
    timeoutS,
  );
}

async function execShell(
  job: JobMeta,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  appendLog(fd, `[runner] kind=sh file=${job.path} timeout=${timeoutS}s`);
  return runSpawn(
    { cmd: ["/bin/bash", job.path], cwd: consumerRoot() },
    fd,
    timeoutS,
  );
}

async function execOnce(
  job: JobMeta,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  try {
    if (job.kind === "md") return await execMarkdown(job, fd, timeoutS);
    if (job.kind === "sh") return await execShell(job, fd, timeoutS);
    return await execTypescript(job, fd, timeoutS);
  } catch (e) {
    appendLog(
      fd,
      `[runner] ERROR: ${(e as Error).stack ?? (e as Error).message}`,
    );
    return { code: 1, timedOut: false };
  }
}

// --- Ledger helpers (failure-safe) ---

function tryOpenDb(): Database | null {
  try {
    return openDb(consumerRoot());
  } catch (e) {
    warn(`open ledger DB failed: ${(e as Error).message}`);
    return null;
  }
}

function tryStartInvocation(
  db: Database | null,
  job: JobMeta,
  trigger: InvocationTrigger,
  logPath: string,
): number | null {
  if (!db) return null;
  try {
    upsertJob(db, job);
    const jobId = getJobIdBySlug(db, job.slug);
    if (jobId === null) return null;
    return startInvocation(db, jobId, trigger, logPath);
  } catch (e) {
    warn(`startInvocation failed: ${(e as Error).message}`);
    return null;
  }
}

function tryFinishInvocation(
  db: Database | null,
  invocationId: number | null,
  status: InvocationStatus,
  exitCode: number | null,
): void {
  if (!db || invocationId === null) return;
  try {
    finishInvocation(db, invocationId, status, exitCode);
  } catch (e) {
    warn(`finishInvocation failed: ${(e as Error).message}`);
  }
}

// --- Top-level orchestration ---

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    console.error("usage: runner.ts <abs-path-to-job-file>");
    process.exit(2);
  }
  const abs = resolve(jobPath);
  if (!existsSync(abs)) {
    console.error(`runner: job file not found: ${abs}`);
    process.exit(2);
  }
  const ext = extname(abs);
  if (ext !== ".md" && ext !== ".ts" && ext !== ".sh") {
    console.error(`runner: unsupported extension ${ext}`);
    process.exit(2);
  }

  const cronDir = join(consumerRoot(), "cron");
  const slug = existsSync(cronDir) ? slugFromPath(cronDir, abs) : undefined;
  const job = loadJob(abs, slug);
  const timeoutS = job.timeout ?? DEFAULT_TIMEOUT_S;
  const retries = job.retries ?? 0;
  const trigger: InvocationTrigger =
    (process.env.CRONFISH_TRIGGER as InvocationTrigger | undefined) ??
    "schedule";

  if (job.concurrency) {
    const got = await waitForLock(job.slug, job.concurrency, timeoutS);
    if (!got) {
      const reason =
        job.concurrency === "skip"
          ? "already running — skipping"
          : "timed out waiting for previous run";
      console.log(`[runner] concurrency=${job.concurrency}: ${reason}`);
      process.exit(0);
    }
  }

  const db = tryOpenDb();

  // Open the log file BEFORE we know the invocation id (we need a real
  // path to record). The DB row references the file path; if DB write
  // failed, the file still lands at preinit-<ts>.log so the run is
  // never blocked.
  const tsTag = new Date().toISOString().replace(/:/g, "-");
  const provisionalPath = logPathFor(job.slug, `preinit-${tsTag}`);
  const invocationId = tryStartInvocation(db, job, trigger, provisionalPath);
  const logFile =
    invocationId !== null
      ? logPathFor(job.slug, invocationId)
      : provisionalPath;
  if (invocationId !== null && logFile !== provisionalPath && db) {
    try {
      db.prepare(
        "UPDATE cron_invocations SET log_path = $p WHERE id = $id",
      ).run({ $p: logFile, $id: invocationId });
    } catch (e) {
      warn(`update log_path failed: ${(e as Error).message}`);
    }
  }

  console.log(`[runner] logging to ${logFile}`);
  const fd = openSync(logFile, "a");
  appendLog(fd, `[runner] slug=${job.slug} start ${new Date().toISOString()}`);
  appendLog(fd, `[runner] cwd=${consumerRoot()}`);
  if (invocationId !== null) {
    appendLog(fd, `[runner] invocation_id=${invocationId} trigger=${trigger}`);
  }

  // Signal handlers — release lock + record crash on launchd shutdown.
  let releasing = false;
  const cleanup = (sig: NodeJS.Signals): void => {
    if (releasing) return;
    releasing = true;
    tryFinishInvocation(
      db,
      invocationId,
      "crashed",
      sig === "SIGTERM" ? 143 : 130,
    );
    if (job.concurrency) releaseLock(job.slug);
    process.exit(sig === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  const start = Date.now();
  let lastResult: SpawnResult = { code: 1, timedOut: false };
  let crashed = false;
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(5 * Math.pow(3, attempt - 1), 60);
        appendLog(
          fd,
          `\n[runner] retry ${attempt}/${retries} — waiting ${delay}s`,
        );
        await Bun.sleep(delay * 1000);
      }
      lastResult = await execOnce(job, fd, timeoutS);
      if (lastResult.code === 0) break;
    }
  } catch (e) {
    crashed = true;
    appendLog(
      fd,
      `\n[runner] CRASH: ${(e as Error).stack ?? (e as Error).message}`,
    );
  } finally {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    appendLog(fd, `\n[runner] exit=${lastResult.code} duration=${dur}s`);
    closeSync(fd);
    if (job.concurrency) releaseLock(job.slug);
    const status: InvocationStatus = crashed
      ? "crashed"
      : lastResult.timedOut
        ? "timeout"
        : lastResult.code === 0
          ? "ok"
          : "fail";
    tryFinishInvocation(db, invocationId, status, lastResult.code);
    try {
      db?.close();
    } catch {}
  }
  process.exit(lastResult.code);
}

main().catch((e) => {
  console.error("runner: fatal", e);
  process.exit(1);
});
