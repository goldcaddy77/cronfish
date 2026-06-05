#!/usr/bin/env bun
// Cronfish runner. Invoked by launchd as:
//   /usr/bin/env bun <runner.ts> <abs-path-to-job-file>
//
// Bun auto-loads .env from cwd (set to consumer root via plist
// WorkingDirectory), so no shell pre-step is needed.
//
// Per-run log: <consumer>/tmp/cron/<slug>/<ISO>.log
// Concurrency lock: <consumer>/tmp/cron/<slug>/runner.pid (atomic O_EXCL).

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

function jobDir(slug: string): string {
  const dir = join(consumerRoot(), "tmp", "cron", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newLogPath(slug: string): string {
  const ts = new Date().toISOString().replace(/:/g, "-");
  return join(jobDir(slug), `${ts}.log`);
}

function appendLog(fd: number, msg: string): void {
  writeSync(fd, msg.endsWith("\n") ? msg : msg + "\n");
}

// --- Concurrency lock (atomic create-or-fail) ---

function lockPath(slug: string): string {
  return join(jobDir(slug), "runner.pid");
}

function tryAcquireLock(slug: string): boolean {
  const path = lockPath(slug);
  try {
    // O_EXCL: fail if file already exists. Atomic create.
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    // Lock exists. Check if its owner is still alive.
    if (!existsSync(path)) return false; // race; retry next tick
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    if (Number.isNaN(pid)) {
      // Corrupt lock — claim it.
      safeRm(path);
      return tryAcquireLock(slug);
    }
    try {
      process.kill(pid, 0);
      return false; // owner alive
    } catch {
      // Stale — claim it.
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

async function runSpawn(
  spec: SpawnSpec,
  fd: number,
  timeoutS: number,
): Promise<number> {
  const proc = Bun.spawn(spec.cmd, {
    cwd: spec.cwd,
    stdout: fd,
    stderr: fd,
    stdin: spec.stdin ?? "ignore",
    // detached so we can SIGTERM the whole process group on timeout
    // (claude/bun children stay attached to the same pgid).
    // Note: in Bun, detached only sets setsid; we still own the pgid.
    // @ts-expect-error — Bun supports detached on spawn options
    detached: true,
  });
  if (spec.stdin === "pipe" && spec.stdinPayload && proc.stdin) {
    // Bun pipe stdin is a writer; cast and finalize.
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
  return timedOut ? 124 : code;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  // Try SIGTERM the whole process group first.
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
): Promise<number> {
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
): Promise<number> {
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
): Promise<number> {
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
): Promise<number> {
  try {
    if (job.kind === "md") return await execMarkdown(job, fd, timeoutS);
    if (job.kind === "sh") return await execShell(job, fd, timeoutS);
    return await execTypescript(job, fd, timeoutS);
  } catch (e) {
    appendLog(
      fd,
      `[runner] ERROR: ${(e as Error).stack ?? (e as Error).message}`,
    );
    return 1;
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

  // Signal handlers — release lock + exit cleanly on launchd shutdown.
  let releasing = false;
  const cleanup = (sig: NodeJS.Signals): void => {
    if (releasing) return;
    releasing = true;
    if (job.concurrency) releaseLock(job.slug);
    process.exit(sig === "SIGTERM" ? 143 : 130);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  const logFile = newLogPath(job.slug);
  console.log(`[runner] logging to ${logFile}`);
  const fd = openSync(logFile, "a");
  appendLog(fd, `[runner] slug=${job.slug} start ${new Date().toISOString()}`);
  appendLog(fd, `[runner] cwd=${consumerRoot()}`);

  const start = Date.now();
  let code = 1;
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
      code = await execOnce(job, fd, timeoutS);
      if (code === 0) break;
    }
  } finally {
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    appendLog(fd, `\n[runner] exit=${code} duration=${dur}s`);
    closeSync(fd);
    if (job.concurrency) releaseLock(job.slug);
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("runner: fatal", e);
  process.exit(1);
});
