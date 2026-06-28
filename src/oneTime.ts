// One-shot scheduled jobs — files under `cron/one-time/`. Each file fires
// exactly once at its `run_at` frontmatter timestamp, then archives itself
// to ~/Library/Application Support/cronfish/done/.
//
// Discovery, install, runner guard, and archive all funnel through this
// module so the failure semantics live in one place: past-grace stale files
// are refused with a sentinel; re-fires are blocked by flock + executed_at;
// archive lives outside the repo so the audit trail can't bloat git.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dlopen, FFIType, suffix } from "bun:ffi";

// --- Constants ---

export const DEFAULT_GRACE_SECONDS = 300; // 5 min
export const ONE_TIME_DIR = "one-time"; // relative to cron/
export const ERRORS_DIR = ".errors"; // relative to cron/

export function archiveDir(): string {
  return join(homedir(), "Library", "Application Support", "cronfish", "done");
}

export function errorsDir(cronDir: string): string {
  return join(cronDir, ERRORS_DIR);
}

export function isOneTimePath(cronDir: string, absPath: string): boolean {
  const prefix = join(cronDir, ONE_TIME_DIR) + "/";
  return absPath.startsWith(prefix);
}

// --- run_at parsing ---

// Absolute ISO (any Date-parseable string) OR relative `+N{s,m,h,d}` against
// the file's mtime. Returns epoch ms.
export function parseRunAt(input: unknown, mtimeMs: number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new Error(`run_at: numeric value must be a positive unix-seconds timestamp, got ${input}`);
    }
    return input * 1000;
  }
  if (typeof input !== "string") {
    throw new Error(`run_at: must be an ISO timestamp string or "+N{s,m,h,d}", got ${typeof input}`);
  }
  const s = input.trim();
  if (!s) throw new Error(`run_at: empty value`);
  const rel = s.match(/^\+(\d+)([smhd])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return mtimeMs + n * unit[rel[2]];
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) {
    throw new Error(`run_at: cannot parse "${s}" — use ISO timestamp or "+N{s,m,h,d}"`);
  }
  return t;
}

// --- Status resolution ---

export type OneTimeStatus =
  | { kind: "executed" } // executed_at already set → skip install
  | { kind: "fire-now" } // within grace, fire on bootstrap
  | { kind: "scheduled"; minute: number; hour: number; day: number; month: number } // future calendar match
  | { kind: "past-grace"; reason: string };

export function resolveOneTime(
  runAtMs: number,
  graceSeconds: number,
  nowMs: number,
  executedAt: string | undefined,
): OneTimeStatus {
  if (executedAt) return { kind: "executed" };
  const ageMs = nowMs - runAtMs;
  if (ageMs > graceSeconds * 1000) {
    return {
      kind: "past-grace",
      reason:
        `run_at=${new Date(runAtMs).toISOString()} + grace=${graceSeconds}s` +
        ` elapsed at ${new Date(runAtMs + graceSeconds * 1000).toISOString()},` +
        ` now=${new Date(nowMs).toISOString()}`,
    };
  }
  if (ageMs >= -1000) {
    return { kind: "fire-now" };
  }
  const d = new Date(runAtMs);
  return {
    kind: "scheduled",
    minute: d.getMinutes(),
    hour: d.getHours(),
    day: d.getDate(),
    month: d.getMonth() + 1,
  };
}

// --- Error sentinel surface ---
//
// A failure for a one-time job writes a sentinel here; consumers (e.g. a
// heartbeat job) sweep the folder and alert on non-empty. Two invariants
// keep the folder from running away:
//
//   1. Dedup — the filename is derived from (slug, hash(reason)), so the
//      SAME error recurring on every sync overwrites one file instead of
//      writing a new one each minute. An unfixed config error is 1 file,
//      not thousands.
//   2. Ownership + class — cronfish-written files carry a `.<class>.cronfish.txt`
//      suffix so a consumer can drop its own sentinels alongside without
//      cronfish reaping them. Class "sync" = re-derived every reconcile
//      (self-heals: reapStaleSentinels removes it once the error stops
//      recurring). Class "run" = a one-shot runtime failure that is NOT
//      re-detected at sync, so it persists until `cronfish errors --clear`.

export type SentinelClass = "sync" | "run";

const SENTINEL_EXT = ".cronfish.txt";

function safeSlug(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Deterministic dedup key: same (slug, reason) → same filename → overwrite.
export function sentinelFilename(
  slug: string,
  reason: string,
  cls: SentinelClass,
): string {
  const hash = createHash("sha1").update(reason).digest("hex").slice(0, 8);
  return `${safeSlug(slug)}--${hash}.${cls}${SENTINEL_EXT}`;
}

export function writeSentinel(
  cronDir: string,
  slug: string,
  reason: string,
  cls: SentinelClass = "run",
): string {
  const dir = errorsDir(cronDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sentinelFilename(slug, reason, cls));
  const body =
    `slug: ${slug}\n` +
    `at: ${new Date().toISOString()}\n` +
    `reason:\n${reason}\n`;
  writeFileSync(path, body, "utf-8");
  return path;
}

// Every file currently in cron/.errors/ (basenames), or [] when absent.
export function listSentinels(cronDir: string): string[] {
  const dir = errorsDir(cronDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".txt"));
}

// Remove sentinels. With no slug, clears the whole folder (cronfish-owned
// AND any legacy/consumer .txt files — the manual `errors --clear` escape
// hatch). With a slug, clears only files for that slug. Returns the count.
export function clearSentinels(cronDir: string, slug?: string): number {
  const dir = errorsDir(cronDir);
  if (!existsSync(dir)) return 0;
  const prefix = slug ? `${safeSlug(slug)}--` : null;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".txt")) continue;
    if (prefix && !f.startsWith(prefix)) continue;
    try {
      rmSync(join(dir, f));
      n++;
    } catch {}
  }
  return n;
}

// Self-heal for "sync"-class sentinels: after a reconcile, delete any
// cronfish "sync" sentinel whose filename was NOT (re)written this run —
// i.e. the error it recorded no longer occurs. "run"-class and foreign
// files are never touched here.
export function reapStaleSentinels(
  cronDir: string,
  keep: Set<string>,
): number {
  const dir = errorsDir(cronDir);
  if (!existsSync(dir)) return 0;
  const suffix = `.sync${SENTINEL_EXT}`;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(suffix)) continue;
    if (keep.has(f)) continue;
    try {
      rmSync(join(dir, f));
      n++;
    } catch {}
  }
  return n;
}

// --- flock-based re-fire guard ---
//
// Real OS-level advisory lock via libc flock(2). Returns the fd on success
// so the caller can hold the lock for the lifetime of the run, or null
// when another process holds it. Pair every success with releaseFlock().

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = dlopen(`libc.${suffix}`, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export interface FlockHandle {
  fd: number;
  path: string;
}

export function tryFlockExclusive(path: string): FlockHandle | null {
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch {
    return null;
  }
  const r = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (r !== 0) {
    try {
      closeSync(fd);
    } catch {}
    return null;
  }
  return { fd, path };
}

export function releaseFlock(h: FlockHandle): void {
  try {
    libc.symbols.flock(h.fd, LOCK_UN);
  } catch {}
  try {
    closeSync(h.fd);
  } catch {}
}

// --- Frontmatter mutation helpers (executed_at) ---
//
// Both .md and .sh use the existing setFrontmatterKey / setShellFrontmatterKey
// helpers. For .ts we patch the `executed_at:` field inside the top-level
// `config = { ... }` block by hand-scan (same approach as rewriteTsEnabled).

export function setTsExecutedAt(source: string, iso: string): string {
  const open = source.search(/\bconfig\b\s*(?::\s*[^=]+)?=\s*\{/);
  if (open < 0) {
    throw new Error("TS one-time job has no top-level `config = { ... }` block");
  }
  const startBody = source.indexOf("{", open) + 1;
  let depth = 1;
  let inStr: string | null = null;
  let endBody = -1;
  for (let i = startBody; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        endBody = i;
        break;
      }
    }
  }
  if (endBody < 0) throw new Error("TS config block is unbalanced");
  const head = source.slice(0, startBody);
  const body = source.slice(startBody, endBody);
  const tail = source.slice(endBody);
  const re = /\bexecuted_at\s*:\s*(?:"[^"]*"|'[^']*'|`[^`]*`)/;
  const next = re.test(body)
    ? body.replace(re, `executed_at: "${iso}"`)
    : `\n  executed_at: "${iso}",${body}`;
  return head + next + tail;
}

// --- Archive ---
//
// Move the source file to ~/Library/Application Support/cronfish/done/ with a
// timestamp prefix so multiple fires of the same template don't collide.

export function archiveOneTime(srcPath: string): string {
  const dir = archiveDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${ts}-${basename(srcPath)}`;
  const dest = join(dir, name);
  renameSync(srcPath, dest);
  return dest;
}

// --- fsync helper for executed_at writes ---

export function writeAndFsync(path: string, contents: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fileMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readUtf8(path: string): string {
  return readFileSync(path, "utf-8");
}
