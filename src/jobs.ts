// Job discovery + validation. cli.ts and runner.ts both go through these
// loaders so strict-field rules are enforced exactly once.
//
// Every field validates: missing → undefined (defaults applied elsewhere),
// wrong type → throw with file + key + expected + got.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  parseFrontmatter,
  parseShellFrontmatter,
  parseTsJobConfig,
  FrontmatterError,
  type Scalar,
  type TsJobConfigShape,
} from "./frontmatter.ts";
import {
  DEFAULT_GRACE_SECONDS,
  isOneTimePath,
  parseRunAt,
} from "./oneTime.ts";

export type JobKind = "md" | "ts" | "sh";
export type Concurrency = "skip" | "queue";

export interface OnFailure {
  notify?: string;
  channel?: string;
}

export interface JobMeta {
  slug: string;
  path: string;
  kind: JobKind;
  enabled: boolean;
  schedule?: string | number;
  timeout?: number;
  model?: string;
  retries?: number;
  concurrency?: Concurrency;
  description?: string;
  missed_after?: string;
  on_failure?: OnFailure;
  // Scoped secrets. When set, only these keys from the consumer .env are
  // injected into the job's launchd plist EnvironmentVariables — instead of
  // the whole .env. Unset → full .env (backward compatible). Note: `.ts` jobs
  // also read `.env` via bun's auto-loader, so `env:` only fences `.md`/`.sh`
  // runs (which rely on the plist block). See README "Security".
  env?: string[];
  // .md jobs only. Capability fence for the Claude Code runner. When set, the
  // run drops `--dangerously-skip-permissions` and instead passes
  // `--allowedTools <list>` under the default permission mode, so any tool not
  // on the list auto-denies in headless mode. Unset → skip-permissions
  // (backward compatible). See README "Security".
  allowed_tools?: string[];
  // .md jobs only. Dollar budget cap for the Claude Code run, passed to the
  // CLI as `--max-budget-usd`. The run stops making API calls once the cap is
  // hit — backstops a runaway loop or an LLM quietly billing on a short cron.
  // Accepts a fraction (e.g. `0.50`). Unset → no cap. See README "Security".
  max_cost?: number;
  // .md jobs only. "Draft but don't send." When true, the run denies the
  // mutating built-in tools (Write, Edit, NotebookEdit, Bash) via
  // `--disallowedTools`, so the model can read/search/draft but not edit files
  // or shell out. Composes with `allowed_tools` (deny wins). MCP sends aren't
  // auto-detected — pair with `allowed_tools` to fence those. See README.
  read_only?: boolean;
  // .md jobs only. When set, the .md is dispatched to a runner registered
  // in `.cronfish.json#runners.<runner>.path` instead of the default
  // claude-cli path. Lets a single .md format target multiple engines
  // (claude CLI, Vercel AI SDK, future LangChain/Mastra, etc.).
  runner?: string;
  // One-shot scheduled jobs (files under `cron/one-time/`).
  oneTime?: boolean;
  runAtMs?: number;
  graceSeconds?: number;
  executedAt?: string;
}

export class JobValidationError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "JobValidationError";
  }
}

function asString(
  path: string,
  key: string,
  val: Scalar | undefined,
): string | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "string") {
    throw new JobValidationError(
      path,
      `${key} must be a string, got ${typeof val}: ${val}`,
    );
  }
  return val;
}

function asScheduleInput(
  path: string,
  val: Scalar | undefined,
): string | number | undefined {
  if (val === undefined) return undefined;
  if (typeof val === "boolean") {
    throw new JobValidationError(
      path,
      `schedule must be a string or number, got boolean`,
    );
  }
  return val;
}

function asPositiveInt(
  path: string,
  key: string,
  val: Scalar | undefined,
  { min }: { min: number },
): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isInteger(val)) {
    throw new JobValidationError(
      path,
      `${key} must be an integer, got ${typeof val}: ${val}`,
    );
  }
  if (val < min) {
    throw new JobValidationError(path, `${key} must be >= ${min}, got ${val}`);
  }
  return val;
}

// Validate an inline-array field (e.g. `env:`). `undefined` (key absent) →
// undefined, meaning "not declared". An explicit empty `[]` stays `[]`,
// meaning "declared but empty". Every item must be a non-empty string; the
// frontmatter parser already produced a string[] so this is mostly a guard.
function asStringList(
  path: string,
  key: string,
  val: string[] | undefined,
): string[] | undefined {
  if (val === undefined) return undefined;
  for (const item of val) {
    if (typeof item !== "string" || item.length === 0) {
      throw new JobValidationError(
        path,
        `${key} entries must be non-empty strings, got: ${JSON.stringify(item)}`,
      );
    }
  }
  return val;
}

// A positive number that may be fractional. The frontmatter parser only
// coerces integers, so a value like `0.50` arrives as the string "0.50" — we
// accept both a parsed number and a numeric string here. `> 0` required.
function asPositiveNumber(
  path: string,
  key: string,
  val: Scalar | undefined,
): number | undefined {
  if (val === undefined) return undefined;
  let n: number;
  if (typeof val === "number") n = val;
  else if (typeof val === "string" && /^\d*\.?\d+$/.test(val.trim())) {
    n = parseFloat(val);
  } else {
    throw new JobValidationError(
      path,
      `${key} must be a positive number, got: ${val}`,
    );
  }
  if (!(n > 0) || !Number.isFinite(n)) {
    throw new JobValidationError(
      path,
      `${key} must be a positive number, got: ${val}`,
    );
  }
  return n;
}

function asConcurrency(
  path: string,
  val: Scalar | undefined,
): Concurrency | undefined {
  if (val === undefined) return undefined;
  if (val !== "skip" && val !== "queue") {
    throw new JobValidationError(
      path,
      `concurrency must be "skip" or "queue", got: ${val}`,
    );
  }
  return val;
}

function asBool(
  path: string,
  key: string,
  val: Scalar | undefined,
  fallback: boolean,
): boolean {
  if (val === undefined) return fallback;
  if (typeof val !== "boolean") {
    throw new JobValidationError(
      path,
      `${key} must be true or false, got: ${val}`,
    );
  }
  return val;
}

// Like asBool but stays undefined when the key is absent — keeps the field off
// the meta entirely unless the author opts in.
function asOptionalBool(
  path: string,
  key: string,
  val: Scalar | undefined,
): boolean | undefined {
  if (val === undefined) return undefined;
  return asBool(path, key, val, false);
}

// Slug = path relative to cron/, with the trailing `.<ext>` rewritten to
// `-<ext>` so the kind is encoded in the slug itself. This makes collisions
// impossible (`foo.md` and `foo.sh` coexist as `foo-md` and `foo-sh`) and
// keeps the launchd label readable. Always forward slashes.
function slugOf(path: string): string {
  return basename(path).replace(/\.(md|ts|sh)$/, "-$1");
}

export function slugFromPath(cronDir: string, absPath: string): string {
  const rel = relative(cronDir, absPath).split("\\").join("/");
  return rel.replace(/\.(md|ts|sh)$/, "-$1");
}

function asOnFailure(
  path: string,
  nested: Record<string, Scalar> | undefined,
): OnFailure | undefined {
  if (!nested) return undefined;
  const out: OnFailure = {};
  const notify = nested.notify;
  if (notify !== undefined) {
    if (typeof notify !== "string") {
      throw new JobValidationError(
        path,
        `on_failure.notify must be a string, got ${typeof notify}: ${notify}`,
      );
    }
    out.notify = notify;
  }
  const channel = nested.channel;
  if (channel !== undefined) {
    if (typeof channel !== "string") {
      throw new JobValidationError(
        path,
        `on_failure.channel must be a string, got ${typeof channel}: ${channel}`,
      );
    }
    out.channel = channel;
  }
  for (const k of Object.keys(nested)) {
    if (k !== "notify" && k !== "channel") {
      throw new JobValidationError(
        path,
        `on_failure.${k}: unknown key (allowed: notify, channel)`,
      );
    }
  }
  return out;
}

// Apply one-time fields and validate the schedule/run_at exclusivity rule.
// Mutates the meta in place. Throws on validation errors.
function applyOneTime(
  meta: JobMeta,
  isOneTime: boolean,
  runAtRaw: Scalar | undefined,
  graceRaw: Scalar | undefined,
  executedAtRaw: Scalar | undefined,
): void {
  if (!isOneTime) {
    if (runAtRaw !== undefined) {
      throw new JobValidationError(
        meta.path,
        `run_at is only valid inside cron/one-time/`,
      );
    }
    return;
  }
  meta.oneTime = true;
  if (meta.schedule !== undefined) {
    throw new JobValidationError(
      meta.path,
      `one-time job must NOT set "schedule"; use "run_at" instead`,
    );
  }
  if (runAtRaw === undefined) {
    throw new JobValidationError(
      meta.path,
      `one-time job missing required "run_at" (ISO timestamp or "+N{s,m,h,d}")`,
    );
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(meta.path).mtimeMs;
  } catch {
    mtimeMs = Date.now();
  }
  try {
    meta.runAtMs = parseRunAt(runAtRaw, mtimeMs);
  } catch (e) {
    throw new JobValidationError(meta.path, (e as Error).message);
  }
  if (graceRaw === undefined) {
    meta.graceSeconds = DEFAULT_GRACE_SECONDS;
  } else if (typeof graceRaw === "number" && Number.isInteger(graceRaw) && graceRaw >= 0) {
    meta.graceSeconds = graceRaw;
  } else {
    throw new JobValidationError(
      meta.path,
      `grace_seconds must be a non-negative integer, got: ${graceRaw}`,
    );
  }
  if (executedAtRaw !== undefined) {
    if (typeof executedAtRaw !== "string") {
      throw new JobValidationError(
        meta.path,
        `executed_at must be a string, got ${typeof executedAtRaw}`,
      );
    }
    meta.executedAt = executedAtRaw;
  }
}

function fromMarkdown(path: string, slug: string, isOneTime: boolean): JobMeta {
  const raw = readFileSync(path, "utf-8");
  let frontmatter: Record<string, Scalar>;
  let nested: Record<string, Record<string, Scalar>>;
  let lists: Record<string, string[]>;
  try {
    const parsed = parseFrontmatter(raw);
    frontmatter = parsed.frontmatter;
    nested = parsed.nested;
    lists = parsed.lists;
  } catch (e) {
    if (e instanceof FrontmatterError)
      throw new JobValidationError(path, e.message);
    throw e;
  }
  const meta: JobMeta = {
    slug,
    path,
    kind: "md",
    enabled: asBool(path, "enabled", frontmatter.enabled, true),
    schedule: asScheduleInput(path, frontmatter.schedule),
    timeout: asPositiveInt(path, "timeout", frontmatter.timeout, { min: 1 }),
    model: asString(path, "model", frontmatter.model) ?? "haiku",
    retries: asPositiveInt(path, "retries", frontmatter.retries, { min: 0 }),
    concurrency: asConcurrency(path, frontmatter.concurrency),
    description: asString(path, "description", frontmatter.description),
    missed_after: asString(path, "missed_after", frontmatter.missed_after),
    on_failure: asOnFailure(path, nested.on_failure),
    env: asStringList(path, "env", lists.env),
    allowed_tools: asStringList(path, "allowed_tools", lists.allowed_tools),
    max_cost: asPositiveNumber(path, "max_cost", frontmatter.max_cost),
    read_only: asOptionalBool(path, "read_only", frontmatter.read_only),
    runner: asString(path, "runner", frontmatter.runner),
  };
  applyOneTime(
    meta,
    isOneTime,
    frontmatter.run_at,
    frontmatter.grace_seconds,
    frontmatter.executed_at,
  );
  return meta;
}

function fromTypescript(path: string, slug: string, isOneTime: boolean): JobMeta {
  const source = readFileSync(path, "utf-8");
  let cfg: TsJobConfigShape;
  try {
    cfg = parseTsJobConfig(source);
  } catch (e) {
    if (e instanceof FrontmatterError)
      throw new JobValidationError(path, e.message);
    throw e;
  }
  const meta: JobMeta = {
    slug,
    path,
    kind: "ts",
    enabled: cfg.enabled ?? true,
    schedule: cfg.schedule,
    timeout: cfg.timeout,
    model: cfg.model,
    retries: cfg.retries,
    concurrency: cfg.concurrency,
    description: cfg.description,
    missed_after: cfg.missed_after,
    on_failure: asOnFailure(path, cfg.on_failure),
    env: asStringList(path, "env", cfg.env),
  };
  applyOneTime(meta, isOneTime, cfg.run_at, cfg.grace_seconds, cfg.executed_at);
  return meta;
}

function fromShell(path: string, slug: string, isOneTime: boolean): JobMeta {
  const raw = readFileSync(path, "utf-8");
  let frontmatter: Record<string, Scalar>;
  let nested: Record<string, Record<string, Scalar>>;
  let lists: Record<string, string[]>;
  try {
    const parsed = parseShellFrontmatter(raw);
    frontmatter = parsed.frontmatter;
    nested = parsed.nested;
    lists = parsed.lists;
  } catch (e) {
    if (e instanceof FrontmatterError)
      throw new JobValidationError(path, e.message);
    throw e;
  }
  if (
    Object.keys(frontmatter).length === 0 &&
    Object.keys(nested).length === 0
  ) {
    throw new JobValidationError(
      path,
      `shell job needs a "# ---" frontmatter block at the top (with at least "schedule:")`,
    );
  }
  const meta: JobMeta = {
    slug,
    path,
    kind: "sh",
    enabled: asBool(path, "enabled", frontmatter.enabled, true),
    schedule: asScheduleInput(path, frontmatter.schedule),
    timeout: asPositiveInt(path, "timeout", frontmatter.timeout, { min: 1 }),
    retries: asPositiveInt(path, "retries", frontmatter.retries, { min: 0 }),
    concurrency: asConcurrency(path, frontmatter.concurrency),
    description: asString(path, "description", frontmatter.description),
    missed_after: asString(path, "missed_after", frontmatter.missed_after),
    on_failure: asOnFailure(path, nested.on_failure),
    env: asStringList(path, "env", lists.env),
  };
  applyOneTime(
    meta,
    isOneTime,
    frontmatter.run_at,
    frontmatter.grace_seconds,
    frontmatter.executed_at,
  );
  return meta;
}

export function loadJob(
  absPath: string,
  slug?: string,
  cronDir?: string,
): JobMeta {
  const ext = extname(absPath);
  const s = slug ?? slugOf(absPath);
  const isOneTime = cronDir ? isOneTimePath(cronDir, absPath) : false;
  if (ext === ".md") return fromMarkdown(absPath, s, isOneTime);
  if (ext === ".ts") return fromTypescript(absPath, s, isOneTime);
  if (ext === ".sh") return fromShell(absPath, s, isOneTime);
  throw new JobValidationError(absPath, `unsupported extension ${ext}`);
}

// Recursively collect every `.md`/`.ts`/`.sh` file under cronDir. The single magic
// filename `README.md` is ignored at any depth so authors can document a
// folder of crons without the README getting parsed as a job.
// Exported for the daemon's mtime scan, which stats files first and only
// parses the changed ones (discoverJobs parses everything).
export function walkJobFiles(cronDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Skip the sentinel folder cronfish writes to under cron/. Anything
        // else (including nested project folders) is recursed.
        if (name === ".errors") continue;
        visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (name === "README.md") continue;
      if (name.endsWith(".md") || name.endsWith(".ts") || name.endsWith(".sh"))
        out.push(full);
    }
  };
  visit(cronDir);
  return out;
}

export function discoverJobs(cronDir: string): {
  jobs: JobMeta[];
  errors: { path: string; message: string }[];
} {
  if (!existsSync(cronDir)) return { jobs: [], errors: [] };
  const entries = walkJobFiles(cronDir);
  const jobs: JobMeta[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const p of entries) {
    try {
      jobs.push(loadJob(p, slugFromPath(cronDir, p), cronDir));
    } catch (e) {
      errors.push({ path: p, message: (e as Error).message });
    }
  }
  jobs.sort((a, b) => a.slug.localeCompare(b.slug));
  return { jobs, errors };
}

// Inverse of slugFromPath: a slug ends in `-md`, `-ts`, or `-sh`. Split the
// suffix to reconstruct the filename. Returns null for malformed slugs or
// missing files.
export function findJobFile(cronDir: string, slug: string): string | null {
  const m = slug.match(/^(.*)-(md|ts|sh)$/);
  if (!m) return null;
  const p = join(cronDir, `${m[1]}.${m[2]}`);
  return existsSync(p) ? p : null;
}
