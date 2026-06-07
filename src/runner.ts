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
  getPreviousFinishedStatus,
  openDb,
  setInvocationAlert,
  startInvocation,
  upsertJob,
  type AlertLedgerStatus,
  type InvocationResultRow,
  type InvocationStatus,
  type InvocationTrigger,
} from "./db.ts";
import { loadJob, slugFromPath, type JobMeta } from "./jobs.ts";
import { resolveModel, localClaudeEnv } from "./models.ts";
import { parseLastResult } from "./result.ts";
import {
  alertStatusFor,
  dispatchAlert,
  type DispatchOutcome,
} from "./alerts/dispatch.ts";

const DEFAULT_TIMEOUT_S = 300;

const MD_RESULT_FOOTER = `---
When finished, print exactly one line, then nothing after it:
__CRONFISH_RESULT_V1__::{"summary":"...","ok":true|false,"metrics":{...}}
Set ok to false if the work did not complete (errors, blocked, skipped). Summary ≤140 chars. No markdown, no code fences.`;
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
  env?: Record<string, string>;
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
    env: spec.env
      ? { ...(process.env as Record<string, string>), ...spec.env }
      : undefined,
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
  const prompt = body.trim() + "\n\n" + MD_RESULT_FOOTER;
  appendLog(
    fd,
    `[runner] kind=md model=${model.provider}:${model.id} timeout=${timeoutS}s`,
  );
  const cmd = [
    CLAUDE_BIN,
    "--dangerously-skip-permissions",
    "--model",
    model.id,
    "-p",
    prompt,
  ];
  const env = model.provider === "local" ? localClaudeEnv(model.id) : undefined;
  if (env) {
    appendLog(
      fd,
      `[runner] local base_url=${env.ANTHROPIC_BASE_URL} model=${model.id}`,
    );
  }
  return runSpawn({ cmd, cwd: consumerRoot(), env }, fd, timeoutS);
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
  result?: InvocationResultRow,
): void {
  if (!db || invocationId === null) return;
  try {
    finishInvocation(db, invocationId, status, exitCode, result);
  } catch (e) {
    warn(`finishInvocation failed: ${(e as Error).message}`);
  }
}

function trySetAlert(
  db: Database | null,
  invocationId: number | null,
  status: AlertLedgerStatus,
  error: string | null,
): void {
  if (!db || invocationId === null) return;
  try {
    setInvocationAlert(db, invocationId, status, error);
  } catch (e) {
    warn(`setInvocationAlert failed: ${(e as Error).message}`);
  }
}

function tryPrevStatus(
  db: Database | null,
  jobSlug: string,
  invocationId: number,
): InvocationStatus | null {
  if (!db) return null;
  try {
    const jobId = getJobIdBySlug(db, jobSlug);
    if (jobId === null) return null;
    return getPreviousFinishedStatus(db, jobId, invocationId);
  } catch (e) {
    warn(`getPreviousFinishedStatus failed: ${(e as Error).message}`);
    return null;
  }
}

function outcomeToLedger(o: DispatchOutcome): {
  status: AlertLedgerStatus;
  error: string | null;
} {
  if (o.kind === "sent") return { status: "sent", error: null };
  if (o.kind === "error") return { status: "error", error: o.error };
  return { status: "skipped", error: null };
}

const FAILURE_STATUSES = new Set<InvocationStatus>([
  "fail",
  "timeout",
  "crashed",
]);

async function tryParseResult(
  logPath: string,
  exitCode: number,
): Promise<InvocationResultRow> {
  try {
    const { result, truncated } = await parseLastResult(logPath);
    if (!result) return { summary: null, ok: null, json: null, truncated };
    const ok = result.ok ?? exitCode === 0;
    return {
      summary: result.summary,
      ok,
      json: JSON.stringify(result),
      truncated,
    };
  } catch (e) {
    warn(`parseLastResult failed: ${(e as Error).message}`);
    return { summary: null, ok: null, json: null, truncated: false };
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
    const resultRow = await tryParseResult(logFile, lastResult.code);
    tryFinishInvocation(db, invocationId, status, lastResult.code, resultRow);
    await maybeFireAlert({
      db,
      job,
      invocationId,
      status,
      trigger,
      exitCode: lastResult.code,
      durationMs: Date.now() - start,
      startedAtIso: new Date(start).toISOString(),
      logPath: logFile,
    });
    try {
      db?.close();
    } catch {}
  }
  process.exit(lastResult.code);
}

interface AlertFireInput {
  db: Database | null;
  job: JobMeta;
  invocationId: number | null;
  status: InvocationStatus;
  trigger: InvocationTrigger;
  exitCode: number | null;
  durationMs: number;
  startedAtIso: string;
  logPath: string;
}

async function maybeFireAlert(input: AlertFireInput): Promise<void> {
  // Manual runs never fire alerts (debugging path).
  if (input.trigger !== "schedule") return;
  if (input.invocationId === null) return;
  const failureStatus = alertStatusFor(input.status);
  const isFailure = failureStatus !== null;
  const isRecovery =
    input.status === "ok" &&
    FAILURE_STATUSES.has(
      tryPrevStatus(input.db, input.job.slug, input.invocationId) ??
        ("ok" as InvocationStatus),
    );
  if (!isFailure && !isRecovery) return;
  try {
    const outcome = await dispatchAlert({
      job: input.job,
      invocationId: input.invocationId,
      invocationStatus: input.status,
      alertStatus: isFailure ? failureStatus : "recovered",
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      startedAt: input.startedAtIso,
      logPath: input.logPath,
      consumerRoot: consumerRoot(),
    });
    if (isRecovery && outcome.kind === "sent") {
      trySetAlert(input.db, input.invocationId, "recovered", null);
    } else {
      const ledger = outcomeToLedger(outcome);
      trySetAlert(input.db, input.invocationId, ledger.status, ledger.error);
    }
  } catch (e) {
    // dispatchAlert is meant to be failure-safe; this catch is a last-resort
    // guard so a runner crash here never blocks the run.
    warn(`maybeFireAlert: ${(e as Error).message}`);
    trySetAlert(input.db, input.invocationId, "error", (e as Error).message);
  }
}

main().catch((e) => {
  console.error("runner: fatal", e);
  process.exit(1);
});
