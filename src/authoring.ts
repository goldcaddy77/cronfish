// Authoring seam — the validated front door for creating a job file.
//
// Files stay the storage and the source of truth (greppable, git-versioned,
// reviewable in a PR). What this module adds is that CREATING one stops being
// a hand-write into a folder where a mistake is silent.
//
// Everything here is pure except `commitNewJob`, so a caller can build a plan,
// SHOW it (that's the point — the next fire times are printed before anything
// is written), and only then commit.
//
// Three invariants:
//   1. The schedule is validated by cronfish's OWN parser (dispatchSchedule),
//      never a regex lookalike, so "it validated" and "the daemon accepts it"
//      cannot diverge.
//   2. Recurring vs one-time is an EXPLICIT choice. A one-time job goes to
//      cron/one-time/ with `run_at:`; pinning a recurring cron expression to a
//      single date (`7 9 29 8 *`) is a different, wrong thing and this seam
//      never produces it.
//   3. The written file is round-tripped back through `loadJob` before the
//      write is considered successful. If cronfish cannot read what we just
//      wrote, the file is removed and the error is raised — no half-armed job.

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Cron } from "croner";
import { JobValidationError, loadJob, type Concurrency, type JobKind } from "./jobs.ts";
import { dispatchSchedule, type Dispatched } from "./schedule.ts";
import { DEFAULT_GRACE_SECONDS, ONE_TIME_DIR } from "./oneTime.ts";

export class AuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoringError";
  }
}

export const JOB_KINDS: JobKind[] = ["md", "ts", "sh"];

// --- name → slug -------------------------------------------------------------

/** Lowercase alnum+dash. Rejects path traversal and names that slugify to nothing. */
export function slugifyJobName(name: string): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new AuthoringError("name is required");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new AuthoringError(
      `name must be a plain job name, not a path: "${name}"`,
    );
  }
  const slug = name
    .toLowerCase()
    .replace(/\.(md|ts|sh)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new AuthoringError(
      `name "${name}" slugifies to nothing — use letters and digits`,
    );
  }
  return slug;
}

// --- run_at ------------------------------------------------------------------

/**
 * Parse a one-time `run_at`. Accepts a Date-parseable ISO string or the
 * relative `+N{s,m,h,d}` form. Must land strictly in the future — a one-time
 * job whose moment already passed is never what the author meant, and past
 * `grace_seconds` it would be refused at load time anyway.
 */
export function parseFutureRunAt(runAt: string, now: Date = new Date()): Date {
  if (typeof runAt !== "string" || !runAt.trim()) {
    throw new AuthoringError(
      'run_at is required — an ISO timestamp (2026-08-29T09:07:00-04:00) or a relative offset ("+90m")',
    );
  }
  const s = runAt.trim();
  const rel = s.match(/^\+(\d+)([smhd])$/);
  if (rel) {
    const unit: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    const ms = parseInt(rel[1], 10) * unit[rel[2]];
    if (ms <= 0) {
      throw new AuthoringError(`run_at "${s}" resolves to now or earlier`);
    }
    return new Date(now.getTime() + ms);
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) {
    throw new AuthoringError(
      `run_at "${s}" is not a parseable timestamp — use ISO (2026-08-29T09:07:00, local; add Z or an offset to pin the zone) or "+90m"`,
    );
  }
  if (t.getTime() <= now.getTime()) {
    throw new AuthoringError(
      `run_at ${toLocalOffsetIso(t)} is in the past (now ${toLocalOffsetIso(now)}) — one-time jobs must be scheduled in the future`,
    );
  }
  return t;
}

/** Local-time ISO WITH an explicit offset — unambiguous in frontmatter. */
export function toLocalOffsetIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

// --- fire-time preview -------------------------------------------------------

/**
 * The next `count` fire times for a recurring schedule, computed the same way
 * the daemon computes them (croner for cron, in the LOCAL timezone; wall-clock
 * addition for intervals). Empty for `manual`.
 *
 * Throws on an unparseable schedule — the caller wants that, loudly.
 */
export function previewFires(
  schedule: string | number,
  count: number,
  from: Date = new Date(),
): Date[] {
  const d: Dispatched = dispatchSchedule(schedule);
  if (d.kind === "manual") return [];
  if (d.kind === "seconds") {
    return Array.from(
      { length: count },
      (_, i) => new Date(from.getTime() + (i + 1) * d.value * 1000),
    );
  }
  const runs = new Cron(d.expr).nextRuns(count, from);
  if (!runs.length) {
    throw new AuthoringError(
      `cron "${d.expr}" has no future occurrence after ${toLocalOffsetIso(from)} — check the day-of-month/month fields`,
    );
  }
  return runs;
}

/** One-line human summary of what a schedule actually resolved to. */
export function describeSchedule(schedule: string | number): string {
  const d = dispatchSchedule(schedule);
  if (d.kind === "manual") return "manual (never auto-fires)";
  if (d.kind === "seconds") return `every ${d.value}s (interval)`;
  return `cron "${d.expr}" (local time)`;
}

/** "in 2h 13m" — the sanity check a timestamp alone doesn't give you. */
export function relativeFromNow(target: Date, now: Date = new Date()): string {
  const ms = target.getTime() - now.getTime();
  const past = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s}s`);
  return past ? `${parts.join(" ")} ago` : `in ${parts.join(" ")}`;
}

// --- file rendering ----------------------------------------------------------

// Frontmatter values stay on one line and quote-free: the parsers are a strict
// YAML subset, and the TS config parser chokes on stray quotes and comments.
function inline(s: string): string {
  return s
    .replace(/[\r\n'"`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RenderOptions {
  kind: JobKind;
  /** Exactly one of these two is set — enforced upstream in planNewJob. */
  schedule?: string;
  runAtIso?: string;
  graceSeconds?: number;
  body: string;
  enabled: boolean;
  description?: string;
  model?: string;
  timeout?: number;
  retries?: number;
  concurrency?: Concurrency;
}

export function renderJobFile(o: RenderOptions): string {
  const body = o.body.trim();
  if (!body) throw new AuthoringError("body is required (the prompt or script)");
  const desc = o.description ? inline(o.description) : undefined;

  // Raw (key, value) pairs in a stable, readable order. Each renderer below
  // turns them into its own literal syntax — one list, three formats.
  const fields: [string, string | number | boolean][] = [];
  if (desc) fields.push(["description", desc]);
  if (o.schedule !== undefined) fields.push(["schedule", inline(o.schedule)]);
  if (o.runAtIso !== undefined) {
    fields.push(["run_at", o.runAtIso]);
    fields.push(["grace_seconds", o.graceSeconds ?? DEFAULT_GRACE_SECONDS]);
  }
  if (o.kind === "md" && o.model) fields.push(["model", o.model]);
  fields.push(["enabled", o.enabled]);
  if (o.timeout !== undefined) fields.push(["timeout", o.timeout]);
  if (o.retries !== undefined) fields.push(["retries", o.retries]);
  if (o.concurrency !== undefined) fields.push(["concurrency", o.concurrency]);

  // Strings are always quoted: cronfish's frontmatter parsers strip a matching
  // pair of quotes, and an unquoted value silently loses everything after a
  // ` #`. Quoting is the difference between "0 9 * * *" and "0 9".
  const lit = (v: string | number | boolean): string =>
    typeof v === "string" ? `"${v}"` : String(v);

  if (o.kind === "md") {
    return [
      "---",
      ...fields.map(([k, v]) => `${k}: ${lit(v)}`),
      "---",
      "",
      body,
      "",
    ].join("\n");
  }

  if (o.kind === "ts") {
    if (/\bexport\s+const\s+config\b/.test(body)) {
      throw new AuthoringError(
        "ts body must not define `export const config` — cronfish generates it from the arguments so there is exactly one source of truth",
      );
    }
    // NEVER put comments inside the config literal — the static parser in
    // frontmatter.ts scans braces and quotes, and a comment defeats it.
    const config = [
      "export const config = {",
      ...fields.map(([k, v]) => `  ${k}: ${lit(v)},`),
      "};",
    ].join("\n");
    const main = /\bexport\s+default\b/.test(body)
      ? body
      : `export default async function run(): Promise<void> {\n${body
          .split("\n")
          .map((l) => (l.trim() ? `  ${l}` : l))
          .join("\n")}\n}`;
    return `${config}\n\n${main}\n`;
  }

  // sh — comment frontmatter after the shebang. We own the shebang line.
  const script = body.replace(/^#![^\n]*\n/, "");
  return [
    "#!/usr/bin/env bash",
    "# ---",
    ...fields.map(([k, v]) => `# ${k}: ${lit(v)}`),
    "# ---",
    "set -euo pipefail",
    "",
    script,
    "",
  ].join("\n");
}

// --- plan / commit -----------------------------------------------------------

export interface NewJobSpec {
  name: string;
  kind: JobKind;
  /** Recurring. Mutually exclusive with runAt. */
  schedule?: string;
  /** One-time. Mutually exclusive with schedule. */
  runAt?: string;
  body?: string;
  description?: string;
  model?: string;
  timeout?: number;
  retries?: number;
  concurrency?: Concurrency;
  graceSeconds?: number;
  enabled?: boolean;
  /** Overwrite an existing file of the same slug. */
  force?: boolean;
  /** Test seam. */
  now?: Date;
}

export interface NewJobPlan {
  /** Filename stem, e.g. "nightly-backup". */
  name: string;
  /** cronfish job slug, e.g. "nightly-backup-sh" or "one-time/flip-back-md". */
  slug: string;
  kind: JobKind;
  path: string;
  relPath: string;
  content: string;
  oneTime: boolean;
  enabled: boolean;
  summary: string;
  /** Next fire times — [] for `manual`, exactly one entry for a one-time job. */
  fires: Date[];
  overwrite: boolean;
}

const PLACEHOLDER_BODY: Record<JobKind, string> = {
  md: "TODO: describe the job. This body is handed to the agent CLI verbatim at fire time.",
  ts: 'console.log("TODO: implement this job");',
  sh: 'echo "TODO: implement this job"',
};

function safeChild(dir: string, filename: string): string {
  const abs = resolve(dir, filename);
  if (!abs.startsWith(resolve(dir) + sep)) {
    throw new AuthoringError(`refusing to write outside ${dir}: ${filename}`);
  }
  return abs;
}

/**
 * Validate a spec and produce everything needed to write the file — WITHOUT
 * writing it. `plan.fires` is the payoff: the caller prints the resolved fire
 * times, so "I hope this parses" becomes "I watched it resolve to Aug 29 09:07".
 */
export function planNewJob(
  cronDir: string,
  spec: NewJobSpec,
  previewCount = 3,
): NewJobPlan {
  const now = spec.now ?? new Date();

  if (!JOB_KINDS.includes(spec.kind)) {
    throw new AuthoringError(
      `kind must be one of ${JOB_KINDS.join("|")}, got "${String(spec.kind)}"`,
    );
  }
  const hasSchedule = spec.schedule !== undefined && spec.schedule !== "";
  const hasRunAt = spec.runAt !== undefined && spec.runAt !== "";
  if (hasSchedule && hasRunAt) {
    throw new AuthoringError(
      "pick one: --schedule (recurring) or --at (one-time). A recurring cron expression pinned to a single date is not a one-time job — it fires again next year.",
    );
  }
  if (!hasSchedule && !hasRunAt) {
    throw new AuthoringError(
      'a job needs a time: --schedule "every day at 9:00" (recurring) or --at 2026-08-29T09:07 (one-time, fires once then archives itself)',
    );
  }
  if (!hasRunAt && spec.graceSeconds !== undefined) {
    throw new AuthoringError("--grace only applies to one-time jobs (--at)");
  }
  if (spec.graceSeconds !== undefined && (!Number.isInteger(spec.graceSeconds) || spec.graceSeconds < 0)) {
    throw new AuthoringError(
      `--grace must be a non-negative integer of seconds, got ${spec.graceSeconds}`,
    );
  }
  if (spec.kind !== "md" && spec.model) {
    throw new AuthoringError(
      `--model only applies to .md jobs (they are handed to an agent CLI); a .${spec.kind} job runs the code you wrote`,
    );
  }

  const name = slugifyJobName(spec.name);
  const dir = hasRunAt ? join(cronDir, ONE_TIME_DIR) : cronDir;
  const path = safeChild(dir, `${name}.${spec.kind}`);
  const slug = hasRunAt
    ? `${ONE_TIME_DIR}/${name}-${spec.kind}`
    : `${name}-${spec.kind}`;

  // Collide across ALL kinds, not just this one: `foo.md` and `foo.sh` are
  // distinct slugs to cronfish but nearly always a mistake by the author.
  let overwrite = false;
  for (const k of JOB_KINDS) {
    const p = join(dir, `${name}.${k}`);
    if (!existsSync(p)) continue;
    if (p === path && spec.force) {
      overwrite = true;
      continue;
    }
    throw new AuthoringError(
      `${relative(cronDir, p)} already exists — pick another name${p === path ? ", or pass --force to overwrite" : ""}`,
    );
  }

  const usingPlaceholder = !spec.body || !spec.body.trim();
  if (usingPlaceholder && hasRunAt) {
    throw new AuthoringError(
      "a one-time job needs a --body (or --body-file): it fires once, at a fixed moment, and a placeholder would burn that moment",
    );
  }
  const body = usingPlaceholder ? PLACEHOLDER_BODY[spec.kind] : spec.body!;
  // A placeholder job must never arm itself — enable it once the body is real.
  const enabled = usingPlaceholder ? false : (spec.enabled ?? true);

  let fires: Date[];
  let summary: string;
  let runAtIso: string | undefined;
  if (hasRunAt) {
    const at = parseFutureRunAt(spec.runAt!, now);
    runAtIso = toLocalOffsetIso(at);
    fires = [at];
    summary = `one-time — fires once at ${runAtIso}, then archives itself`;
  } else {
    summary = describeSchedule(spec.schedule!);
    fires = previewFires(spec.schedule!, previewCount, now);
  }

  const content = renderJobFile({
    kind: spec.kind,
    schedule: hasRunAt ? undefined : spec.schedule,
    runAtIso,
    graceSeconds: spec.graceSeconds,
    body,
    enabled,
    description: spec.description,
    model: spec.kind === "md" ? (spec.model ?? "haiku") : undefined,
    timeout: spec.timeout,
    retries: spec.retries,
    concurrency: spec.concurrency,
  });

  return {
    name,
    slug,
    kind: spec.kind,
    path,
    relPath: relative(cronDir, path),
    content,
    oneTime: hasRunAt,
    enabled,
    summary,
    fires,
    overwrite,
  };
}

/**
 * Write the planned file, then read it back through cronfish's real loader.
 * A file cronfish cannot parse is deleted and the error raised — the whole
 * point of this seam is that a `cronfish new` that returns 0 means the job is
 * genuinely loadable, not merely written.
 */
export function commitNewJob(cronDir: string, plan: NewJobPlan): void {
  mkdirSync(join(plan.path, ".."), { recursive: true });
  const existed = existsSync(plan.path);
  writeFileSync(plan.path, plan.content, "utf-8");
  if (plan.kind === "sh") chmodSync(plan.path, 0o755);
  try {
    const meta = loadJob(plan.path, plan.slug, cronDir);
    if (plan.oneTime && !meta.oneTime) {
      throw new JobValidationError(
        plan.path,
        "written as one-time but did not load as one — is cronDir wrong?",
      );
    }
  } catch (e) {
    if (!existed) {
      try {
        rmSync(plan.path);
      } catch {}
    }
    throw new AuthoringError(
      `cronfish wrote ${plan.relPath} but could not load it back: ${(e as Error).message}\n` +
        `The file was removed. This is a cronfish bug — please report it with the arguments you used.`,
    );
  }
}
