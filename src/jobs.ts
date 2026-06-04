// Job discovery + validation. cli.ts and runner.ts both go through these
// loaders so strict-field rules are enforced exactly once.
//
// Every field validates: missing → undefined (defaults applied elsewhere),
// wrong type → throw with file + key + expected + got.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import {
  parseFrontmatter,
  parseTsJobConfig,
  FrontmatterError,
  type Scalar,
  type TsJobConfigShape,
} from "./frontmatter.ts";

export type JobKind = "md" | "ts";
export type Concurrency = "skip" | "queue";

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

function slugOf(path: string): string {
  return basename(path).replace(/\.(md|ts)$/, "");
}

// Convert an absolute job-file path to its slug, given the cron/ root.
// Slug = path relative to cron/, with the extension stripped.
// Always uses forward slashes (even on Windows-style paths, which we don't
// support yet — but the convention is portable).
export function slugFromPath(cronDir: string, absPath: string): string {
  const rel = relative(cronDir, absPath).split("\\").join("/");
  return rel.replace(/\.(md|ts)$/, "");
}

function fromMarkdown(path: string, slug: string): JobMeta {
  const raw = readFileSync(path, "utf-8");
  let frontmatter: Record<string, Scalar>;
  try {
    frontmatter = parseFrontmatter(raw).frontmatter;
  } catch (e) {
    if (e instanceof FrontmatterError)
      throw new JobValidationError(path, e.message);
    throw e;
  }
  return {
    slug,
    path,
    kind: "md",
    enabled: asBool(path, "enabled", frontmatter.enabled, true),
    schedule: asScheduleInput(path, frontmatter.schedule),
    timeout: asPositiveInt(path, "timeout", frontmatter.timeout, { min: 1 }),
    model: asString(path, "model", frontmatter.model) ?? "haiku",
    retries: asPositiveInt(path, "retries", frontmatter.retries, { min: 0 }),
    concurrency: asConcurrency(path, frontmatter.concurrency),
  };
}

function fromTypescript(path: string, slug: string): JobMeta {
  const source = readFileSync(path, "utf-8");
  let cfg: TsJobConfigShape;
  try {
    cfg = parseTsJobConfig(source);
  } catch (e) {
    if (e instanceof FrontmatterError)
      throw new JobValidationError(path, e.message);
    throw e;
  }
  return {
    slug,
    path,
    kind: "ts",
    enabled: cfg.enabled ?? true,
    schedule: cfg.schedule,
    timeout: cfg.timeout,
    model: cfg.model,
    retries: cfg.retries,
    concurrency: cfg.concurrency,
  };
}

export function loadJob(absPath: string, slug?: string): JobMeta {
  const ext = extname(absPath);
  const s = slug ?? slugOf(absPath);
  if (ext === ".md") return fromMarkdown(absPath, s);
  if (ext === ".ts") return fromTypescript(absPath, s);
  throw new JobValidationError(absPath, `unsupported extension ${ext}`);
}

// Recursively collect every `.md`/`.ts` file under cronDir. The single magic
// filename `README.md` is ignored at any depth so authors can document a
// folder of crons without the README getting parsed as a job.
function walkJobFiles(cronDir: string): string[] {
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
        visit(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (name === "README.md") continue;
      if (name.endsWith(".md") || name.endsWith(".ts")) out.push(full);
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
      jobs.push(loadJob(p, slugFromPath(cronDir, p)));
    } catch (e) {
      errors.push({ path: p, message: (e as Error).message });
    }
  }
  jobs.sort((a, b) => a.slug.localeCompare(b.slug));
  return { jobs, errors };
}

export function findJobFile(cronDir: string, slug: string): string | null {
  for (const ext of [".md", ".ts"]) {
    const p = join(cronDir, `${slug}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}
