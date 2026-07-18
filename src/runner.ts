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
  linkRunRequestInvocation,
  openDb,
  setInvocationAlert,
  setJobLastRun,
  startInvocation,
  upsertJob,
  type AlertLedgerStatus,
  type InvocationResultRow,
  type InvocationStatus,
  type InvocationTrigger,
} from "./db.ts";
import { loadJob, slugFromPath, type JobMeta } from "./jobs.ts";
import { resolveModel, claudeEnvFor } from "./models.ts";
import {
  DEFAULT_GRACE_SECONDS,
  archiveOneTime,
  releaseFlock,
  resolveOneTime,
  setTsExecutedAt,
  tryFlockExclusive,
  writeAndFsync,
  writeSentinel,
  type FlockHandle,
} from "./oneTime.ts";
import { loadBundlePrefix } from "./config.ts";
import { platform } from "./platform/index.ts";
import { setFrontmatterKey, setShellFrontmatterKey } from "./frontmatter.ts";
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

// Custom runner registry loaded from .cronfish.json. Each entry maps a
// frontmatter `runner:` name to an executable script (resolved relative
// to consumer root). When a .md job declares `runner: <name>`, we spawn
// that script with the .md path as argv[2] instead of the default claude
// CLI path. The script is responsible for parsing the frontmatter + body,
// driving the model, and printing the __CRONFISH_RESULT_V1__ line.
//
// Failure-safe: malformed runners config logs a warning and falls back to
// claude CLI for that run. A typo in .cronfish.json shouldn't brick every
// .md cron.

interface RunnerSpec {
  path: string;
}

function loadRunners(): Record<string, RunnerSpec> {
  const cfgPath = join(consumerRoot(), ".cronfish.json");
  if (!existsSync(cfgPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      runners?: Record<string, { path?: string }>;
    };
    const out: Record<string, RunnerSpec> = {};
    for (const [name, spec] of Object.entries(raw.runners ?? {})) {
      if (!spec?.path || typeof spec.path !== "string") continue;
      out[name] = { path: spec.path };
    }
    return out;
  } catch (e) {
    warn(`runners config: ${(e as Error).message}`);
    return {};
  }
}

async function execMarkdownCustomRunner(
  job: JobMeta,
  spec: RunnerSpec,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  const runnerPath = resolve(consumerRoot(), spec.path);
  appendLog(
    fd,
    `[runner] kind=md runner=${job.runner} path=${runnerPath} timeout=${timeoutS}s`,
  );
  if (!existsSync(runnerPath)) {
    appendLog(
      fd,
      `[runner] ERROR: runner script not found at ${runnerPath} — check .cronfish.json runners.${job.runner}.path`,
    );
    return { code: 1, timedOut: false };
  }
  return runSpawn(
    { cmd: ["bun", runnerPath, job.path], cwd: consumerRoot() },
    fd,
    timeoutS,
  );
}

// Build the `claude` CLI argv for a .md job. Pure (no I/O) so it's unit
// testable. Default posture is `--dangerously-skip-permissions` (backward
// compatible). When the job declares `allowed_tools`, swap to a capability
// fence: `--permission-mode default --allowedTools <list>` — off-list tools
// auto-deny in headless `-p` mode.
// Mutating built-in tools denied by `read_only:`. Reading/searching and MCP
// tools stay available; MCP sends must be fenced via `allowed_tools`.
const READ_ONLY_DENY = ["Write", "Edit", "NotebookEdit", "Bash"];

export function buildClaudeArgs(
  claudeBin: string,
  job: Pick<JobMeta, "allowed_tools" | "max_cost" | "read_only">,
  modelId: string,
  prompt: string,
): string[] {
  const cmd = [claudeBin];
  if (job.allowed_tools) {
    cmd.push("--permission-mode", "default");
    cmd.push("--allowedTools", ...job.allowed_tools);
  } else {
    cmd.push("--dangerously-skip-permissions");
  }
  if (job.read_only) {
    // Hard-remove the mutating built-ins. `--disallowedTools` wins over both
    // skip-permissions and an `--allowedTools` overlap, so this holds under
    // either posture.
    cmd.push("--disallowedTools", ...READ_ONLY_DENY);
  }
  if (job.max_cost !== undefined) {
    // CLI stops making API calls once the budget is hit (works with -p/--print).
    cmd.push("--max-budget-usd", String(job.max_cost));
  }
  cmd.push("--model", modelId, "-p", prompt);
  return cmd;
}

async function execMarkdown(
  job: JobMeta,
  fd: number,
  timeoutS: number,
): Promise<SpawnResult> {
  if (job.runner) {
    const runners = loadRunners();
    const spec = runners[job.runner];
    if (spec) return execMarkdownCustomRunner(job, spec, fd, timeoutS);
    // Hard-fail rather than fall back to claude CLI. The cron's prompt
    // is shaped for a specific runner; sending an ai-sdk-shaped prompt
    // (with tool-call protocol the CLI doesn't speak) through claude CLI
    // can corrupt vault files. Better to alert than to silently misroute.
    const known = Object.keys(runners).join(", ") || "(none)";
    appendLog(
      fd,
      `[runner] ERROR: runner "${job.runner}" not in .cronfish.json#runners — known: ${known}. Refusing to fall back to claude CLI.`,
    );
    return { code: 2, timedOut: false };
  }
  const raw = await Bun.file(job.path).text();
  const { parseFrontmatter } = await import("./frontmatter.ts");
  const { body } = parseFrontmatter(raw);
  const model = resolveModel(job.model);
  const prompt = body.trim() + "\n\n" + MD_RESULT_FOOTER;
  appendLog(
    fd,
    `[runner] kind=md model=${model.provider}:${model.id} timeout=${timeoutS}s`,
  );
  if (job.allowed_tools) {
    appendLog(
      fd,
      `[runner] permission fence: allowedTools=[${job.allowed_tools.join(", ")}]`,
    );
  }
  if (job.max_cost !== undefined) {
    appendLog(fd, `[runner] budget cap: max_cost=$${job.max_cost}`);
  }
  if (job.read_only) {
    appendLog(fd, `[runner] read-only: deny [${READ_ONLY_DENY.join(", ")}]`);
  }
  const cmd = buildClaudeArgs(CLAUDE_BIN, job, model.id, prompt);
  const env = claudeEnvFor(model);
  if (env) {
    appendLog(
      fd,
      `[runner] ${model.provider} base_url=${env.ANTHROPIC_BASE_URL} model=${model.id}`,
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
    // Daemon context, both optional: the planned fire time (lateness
    // reporting) and the `cron run` request this invocation fulfills.
    const scheduledFor = process.env.CRONFISH_SCHEDULED_FOR || undefined;
    const id = startInvocation(db, jobId, trigger, logPath, { scheduledFor });
    const reqId = process.env.CRONFISH_RUN_REQUEST_ID;
    if (reqId && /^\d+$/.test(reqId)) {
      try {
        linkRunRequestInvocation(db, parseInt(reqId, 10), id);
      } catch (e) {
        warn(`linkRunRequestInvocation failed: ${(e as Error).message}`);
      }
    }
    return id;
  } catch (e) {
    warn(`startInvocation failed: ${(e as Error).message}`);
    return null;
  }
}

// Stamp cron_jobs.last_run_at/last_status at finish. The daemon's
// schedule-change rule (next = max(now, last_run + new_interval)) reads
// last_run_at, so the runner — the one place that knows how a run ended —
// maintains it. Failure-safe like every ledger write.
function trySetJobLastRun(
  db: Database | null,
  jobSlug: string,
  startedAtIso: string,
  status: InvocationStatus,
): void {
  if (!db) return;
  try {
    const jobId = getJobIdBySlug(db, jobSlug);
    if (jobId === null) return;
    setJobLastRun(db, jobId, startedAtIso, status);
  } catch (e) {
    warn(`setJobLastRun failed: ${(e as Error).message}`);
  }
}

function tryFinishInvocation(
  db: Database | null,
  invocationId: number | null,
  status: InvocationStatus,
  exitCode: number | null,
  result?: InvocationResultRow,
  attempt?: number,
): void {
  if (!db || invocationId === null) return;
  try {
    finishInvocation(db, invocationId, status, exitCode, result, attempt);
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

// --- One-shot completion ---
//
// On any termination of a one-time job (success or failure), stamp
// `executed_at: <ISO>` into the source file's frontmatter, fsync, and
// move the file to ~/Library/Application Support/cronfish/done/. The
// flock + executed_at re-fire guard depends on this write landing before
// the file is archived. Failures here surface as sentinels but never
// crash the runner.

function stampExecutedAt(job: JobMeta, iso: string): void {
  if (!existsSync(job.path)) return;
  const raw = readFileSync(job.path, "utf-8");
  let next: string;
  if (job.kind === "md") {
    next = setFrontmatterKey(raw, "executed_at", iso);
  } else if (job.kind === "sh") {
    next = setShellFrontmatterKey(raw, "executed_at", iso);
  } else {
    next = setTsExecutedAt(raw, iso);
  }
  writeAndFsync(job.path, next);
}

// Remove this one-time job's own launchd plist after it has fired. Without
// this, a fire-now plist (RunAtLoad=true, no calendar) lingers in
// ~/Library/LaunchAgents until the NEXT `cronfish sync` boots it out — and a
// reboot/login in that window reloads it and re-fires (against an already-
// archived file). Self-removing here closes that window regardless of when
// the consumer next syncs. Best-effort: failures never block completion.
function selfRemoveOneTimePlist(job: JobMeta): void {
  // Logs to console (→ launchd.out/err), not the per-run fd: this runs as the
  // last act after the log fd is already closed, and the bootout it performs
  // may terminate this process, so it must follow all ledger/alert work.
  try {
    const prefix = loadBundlePrefix(consumerRoot());
    const existed = platform().removeOneTimeSelf(prefix, job.slug);
    console.log(`[runner] one-time: removed own plist (existed=${existed})`);
  } catch (e) {
    console.error(
      `[runner] one-time: self-remove plist failed: ${(e as Error).message}`,
    );
  }
}

function completeOneTime(job: JobMeta, fd: number): void {
  if (!job.oneTime) return;
  const iso = new Date().toISOString();
  try {
    stampExecutedAt(job, iso);
  } catch (e) {
    appendLog(fd, `[runner] one-time: stampExecutedAt failed: ${(e as Error).message}`);
    try {
      writeSentinel(
        join(consumerRoot(), "cron"),
        job.slug,
        `stampExecutedAt failed: ${(e as Error).message}`,
      );
    } catch {}
    return;
  }
  try {
    const dest = archiveOneTime(job.path);
    appendLog(fd, `[runner] one-time: archived to ${dest}`);
  } catch (e) {
    appendLog(fd, `[runner] one-time: archive failed: ${(e as Error).message}`);
    try {
      writeSentinel(
        join(consumerRoot(), "cron"),
        job.slug,
        `archive failed: ${(e as Error).message}`,
      );
    } catch {}
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
  const job = loadJob(abs, slug, cronDir);
  const timeoutS = job.timeout ?? DEFAULT_TIMEOUT_S;
  const retries = job.retries ?? 0;
  const trigger: InvocationTrigger =
    (process.env.CRONFISH_TRIGGER as InvocationTrigger | undefined) ??
    "schedule";

  // One-time re-fire guard: flock the source file + re-check executed_at.
  // Both checks must happen before any work, so launchd retries / system
  // unsleep / crash recovery can't double-fire the job. Lock is held for
  // the lifetime of this process; release is implicit on exit.
  let oneTimeLock: FlockHandle | null = null;
  if (job.oneTime) {
    if (job.executedAt) {
      console.log(
        `[runner] one-time: ${job.slug} already executed at ${job.executedAt} — exit`,
      );
      process.exit(0);
    }
    oneTimeLock = tryFlockExclusive(abs);
    if (!oneTimeLock) {
      console.log(
        `[runner] one-time: ${job.slug} lock held by another process — exit`,
      );
      process.exit(0);
    }
    // Re-parse under lock — the file could have been stamped between
    // discovery and lock acquisition.
    try {
      const fresh = loadJob(abs, slug, cronDir);
      if (fresh.executedAt) {
        console.log(
          `[runner] one-time: ${job.slug} stamped under-lock at ${fresh.executedAt} — exit`,
        );
        releaseFlock(oneTimeLock);
        process.exit(0);
      }
    } catch {
      // re-parse failed; proceed with the original meta.
    }

    // Re-assert grace at RUN time. launchd fires a StartCalendarInterval job
    // once on wake if the machine was asleep/off through the scheduled minute
    // (coalesced) — which can land long past run_at. Grace is checked at sync
    // time, but nothing re-checks it when launchd actually fires. Refuse a
    // stale wake-up fire so a one-time job can't run hours/days late, and
    // remove the plist so it won't try again on the next wake.
    if (job.runAtMs !== undefined) {
      const grace = job.graceSeconds ?? DEFAULT_GRACE_SECONDS;
      const status = resolveOneTime(job.runAtMs, grace, Date.now(), undefined);
      if (status.kind === "past-grace") {
        console.error(
          `[runner] one-time: ${job.slug} fired past grace — refusing. ${status.reason}`,
        );
        try {
          writeSentinel(
            join(consumerRoot(), "cron"),
            job.slug,
            `runtime past grace: ${status.reason}`,
            "run",
          );
        } catch {}
        if (oneTimeLock) releaseFlock(oneTimeLock);
        selfRemoveOneTimePlist(job);
        process.exit(0);
      }
    }
  }

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

  // Install lock-release signal handlers the instant a lock exists. There is
  // real setup below (DB init, log open) before the full `cleanup` handler is
  // registered, and a SIGTERM in that window would otherwise kill the process
  // by default disposition — no handler runs, and the concurrency lockfile is
  // orphaned (unlike the flock, it is not reclaimed by the OS on exit). This
  // minimal handler is superseded by `cleanup` once the invocation state exists.
  let releasing = false;
  const earlyCleanup = (sig: NodeJS.Signals): void => {
    if (releasing) return;
    releasing = true;
    if (job.concurrency) releaseLock(job.slug);
    if (oneTimeLock) releaseFlock(oneTimeLock);
    process.exit(sig === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGTERM", earlyCleanup);
  process.on("SIGINT", earlyCleanup);

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

  // Signal handlers — release lock + record crash on launchd shutdown. This
  // supersedes earlyCleanup now that the invocation row exists, so a SIGTERM
  // also records the run as crashed. The off→on swap is synchronous (no await
  // between), so no signal can slip through with zero handlers installed.
  process.off("SIGTERM", earlyCleanup);
  process.off("SIGINT", earlyCleanup);
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
    if (oneTimeLock) releaseFlock(oneTimeLock);
    process.exit(sig === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  const start = Date.now();
  let lastResult: SpawnResult = { code: 1, timedOut: false };
  let crashed = false;
  // 1-based count of attempts actually made — recorded on the invocation row
  // at finish so `cron history` shows real retry data, not a constant 1.
  let attemptsUsed = 1;
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
      attemptsUsed = attempt + 1;
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
    // One-time completion: write executed_at + archive BEFORE we close the
    // log fd, so the archive line lands in the log. Then release flock.
    if (job.oneTime) {
      completeOneTime(job, fd);
      if (oneTimeLock) releaseFlock(oneTimeLock);
    }
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
    tryFinishInvocation(
      db,
      invocationId,
      status,
      lastResult.code,
      resultRow,
      attemptsUsed,
    );
    trySetJobLastRun(db, job.slug, new Date(start).toISOString(), status);
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
    // LAST act for a one-time job: remove its own plist. May SIGTERM us via
    // bootout, so everything above (ledger, alert) is already done.
    if (job.oneTime) selfRemoveOneTimePlist(job);
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

// Guarded so the module can be imported (e.g. by unit tests for the pure
// helpers above) without launching a run. launchd invokes this file as the
// program entry, where import.meta.main is true.
if (import.meta.main) {
  main().catch((e) => {
    console.error("runner: fatal", e);
    process.exit(1);
  });
}
