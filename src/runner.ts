#!/usr/bin/env bun
// Cronfish runner. Invoked by launchd via runner.sh with one arg: the absolute
// path of a job file (.md or .ts) under <consumer>/cron/.
//
// .md  → parse frontmatter, resolve model, spawn `claude -p` (or local model).
// .ts  → spawn ts-shim subprocess; the shim imports + awaits the default export.
//
// Per-run logs go to <consumer>/tmp/cron/<slug>/<ISO>.log.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseFrontmatter, parseTsJobConfig } from "./frontmatter.ts";
import { resolveModel, localCommand } from "./models.ts";

function consumerRoot(): string {
  return process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
}

const DEFAULT_TIMEOUT_S = 300;
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  join(process.env.HOME ?? "", ".local", "bin", "claude");

function slugOf(path: string): string {
  return basename(path).replace(/\.(md|ts)$/, "");
}

function logPathFor(slug: string): string {
  const dir = join(consumerRoot(), "tmp", "cron", slug);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  return join(dir, `${ts}.log`);
}

async function runMarkdown(
  path: string,
  slug: string,
  logFile: string,
): Promise<number> {
  const root = consumerRoot();
  const raw = await Bun.file(path).text();
  const { frontmatter, body } = parseFrontmatter(raw);
  const model = resolveModel(frontmatter.model as string | undefined);
  const timeoutS =
    (frontmatter.timeout as number | undefined) ?? DEFAULT_TIMEOUT_S;
  const prompt = body.trim();

  const fd = openSync(logFile, "a");
  const header = [
    `[runner] slug=${slug} kind=md model=${model.provider}:${model.id} timeout=${timeoutS}s`,
    `[runner] start ${new Date().toISOString()}`,
    `[runner] cwd=${root}`,
    "",
  ].join("\n");
  writeSync(fd, header);

  const start = Date.now();
  let exitCode = 0;
  try {
    if (model.provider === "anthropic") {
      const proc = Bun.spawn(
        [
          CLAUDE_BIN,
          "--dangerously-skip-permissions",
          "--model",
          model.id,
          "-p",
          prompt,
        ],
        { cwd: root, stdout: fd, stderr: fd, stdin: "ignore" },
      );
      const timer = setTimeout(() => {
        writeSync(fd, `\n[runner] timeout after ${timeoutS}s — killing\n`);
        proc.kill("SIGTERM");
      }, timeoutS * 1000);
      exitCode = await proc.exited;
      clearTimeout(timer);
    } else {
      const { cmd, stdin } = localCommand(model.id, prompt);
      const proc = Bun.spawn(cmd, {
        cwd: root,
        stdout: fd,
        stderr: fd,
        stdin: "pipe",
      });
      proc.stdin?.write(stdin);
      proc.stdin?.end();
      const timer = setTimeout(() => {
        writeSync(fd, `\n[runner] timeout after ${timeoutS}s — killing\n`);
        proc.kill("SIGTERM");
      }, timeoutS * 1000);
      exitCode = await proc.exited;
      clearTimeout(timer);
    }
  } catch (e) {
    exitCode = 1;
    writeSync(fd, `\n[runner] ERROR: ${(e as Error).message}\n`);
  }
  const dur = ((Date.now() - start) / 1000).toFixed(1);
  writeSync(fd, `\n[runner] exit=${exitCode} duration=${dur}s\n`);
  closeSync(fd);
  return exitCode;
}

async function runTypescript(
  path: string,
  slug: string,
  logFile: string,
): Promise<number> {
  const source = readFileSync(path, "utf-8");
  const cfg = parseTsJobConfig(source);
  const timeoutS = cfg.timeout ?? DEFAULT_TIMEOUT_S;

  const fd = openSync(logFile, "a");
  const header = [
    `[runner] slug=${slug} kind=ts file=${path} timeout=${timeoutS}s`,
    `[runner] start ${new Date().toISOString()}`,
    "",
  ].join("\n");
  writeSync(fd, header);

  const shim = resolve(import.meta.dir, "ts-shim.ts");
  const start = Date.now();
  let exitCode = 0;
  try {
    const proc = Bun.spawn(["bun", shim, path], {
      cwd: consumerRoot(),
      stdout: fd,
      stderr: fd,
      stdin: "ignore",
    });
    const timer = setTimeout(() => {
      writeSync(fd, `\n[runner] timeout after ${timeoutS}s — killing\n`);
      proc.kill("SIGTERM");
    }, timeoutS * 1000);
    exitCode = await proc.exited;
    clearTimeout(timer);
  } catch (e) {
    exitCode = 1;
    writeSync(
      fd,
      `\n[runner] ERROR: ${(e as Error).stack ?? (e as Error).message}\n`,
    );
  }
  const dur = ((Date.now() - start) / 1000).toFixed(1);
  writeSync(fd, `\n[runner] exit=${exitCode} duration=${dur}s\n`);
  closeSync(fd);
  return exitCode;
}

// --- Concurrency lock (PID file) ---

const LOCK_POLL_MS = 2_000;

function lockPathFor(slug: string): string {
  return join(consumerRoot(), "tmp", "cron", slug, "runner.pid");
}

function isLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    try {
      rmSync(lockPath);
    } catch {}
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      rmSync(lockPath);
    } catch {}
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath);
  } catch {}
}

async function waitForLock(
  slug: string,
  concurrency: "skip" | "queue",
  timeoutS: number,
): Promise<boolean> {
  const lockPath = lockPathFor(slug);
  mkdirSync(join(consumerRoot(), "tmp", "cron", slug), { recursive: true });
  if (!isLockHeld(lockPath)) {
    writeFileSync(lockPath, String(process.pid), "utf-8");
    return true;
  }
  if (concurrency === "skip") return false;
  const deadline = Date.now() + timeoutS * 1_000;
  while (Date.now() < deadline) {
    await Bun.sleep(LOCK_POLL_MS);
    if (!isLockHeld(lockPath)) {
      writeFileSync(lockPath, String(process.pid), "utf-8");
      return true;
    }
  }
  return false;
}

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
  const slug = slugOf(abs);
  const ext = extname(abs);

  let retries = 0;
  let concurrency: "skip" | "queue" | undefined;
  let baseTimeoutS = DEFAULT_TIMEOUT_S;
  if (ext === ".md") {
    const raw = await Bun.file(abs).text();
    const { frontmatter } = parseFrontmatter(raw);
    retries = Math.max(0, (frontmatter.retries as number | undefined) ?? 0);
    const c = frontmatter.concurrency as string | undefined;
    if (c === "skip" || c === "queue") concurrency = c;
    baseTimeoutS =
      (frontmatter.timeout as number | undefined) ?? DEFAULT_TIMEOUT_S;
  } else if (ext === ".ts") {
    const source = readFileSync(abs, "utf-8");
    const cfg = parseTsJobConfig(source);
    retries = Math.max(0, cfg.retries ?? 0);
    concurrency = cfg.concurrency;
    baseTimeoutS = cfg.timeout ?? DEFAULT_TIMEOUT_S;
  }

  if (concurrency) {
    const acquired = await waitForLock(slug, concurrency, baseTimeoutS);
    if (!acquired) {
      const reason =
        concurrency === "skip"
          ? "already running — skipping"
          : "timed out waiting for previous run";
      console.log(`[runner] concurrency=${concurrency}: ${reason}`);
      process.exit(0);
    }
  }

  const logFile = logPathFor(slug);
  console.log(`[runner] logging to ${logFile}`);

  let code = 1;
  const lockPath = lockPathFor(slug);
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delaySec = Math.min(5 * Math.pow(3, attempt - 1), 60);
        const fd = openSync(logFile, "a");
        writeSync(
          fd,
          `\n[runner] retry ${attempt}/${retries} — waiting ${delaySec}s\n`,
        );
        closeSync(fd);
        await Bun.sleep(delaySec * 1_000);
      }
      if (ext === ".md") code = await runMarkdown(abs, slug, logFile);
      else if (ext === ".ts") code = await runTypescript(abs, slug, logFile);
      else {
        console.error(`runner: unsupported extension ${ext}`);
        code = 2;
        break;
      }
      if (code === 0) break;
    }
  } finally {
    if (concurrency) releaseLock(lockPath);
  }
  process.exit(code);
}

main().catch((e) => {
  console.error("runner: fatal", e);
  process.exit(1);
});
