#!/usr/bin/env bun
// cronfish CLI. Verbs are thin wrappers; discovery lives in jobs.ts, plist
// I/O lives in platform/launchd.ts, schedule parsing in schedule.ts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setFrontmatterKey, setShellFrontmatterKey } from "./frontmatter.ts";
import { discoverJobs, findJobFile, loadJob, type JobMeta } from "./jobs.ts";
import { dispatchSchedule, type Dispatched } from "./schedule.ts";
import { resolveOneTime, writeSentinel } from "./oneTime.ts";
import { platform } from "./platform/index.ts";
import { loadState, rememberPrefix } from "./state.ts";
import { dbPath, markDeleted, openDb, upsertJob } from "./db.ts";
import {
  formatBytes,
  pruneLogs,
  type PruneReport,
  type SlugRetention,
} from "./prune.ts";
import { Database } from "bun:sqlite";
import { startUiServer } from "./ui/server.ts";

const VERSION = "0.11.0";

const CONSUMER_ROOT = process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
const CRON_DIR = join(CONSUMER_ROOT, "cron");

// --- Consumer config ---

interface RetentionConfig {
  max_age_days?: number;
  max_runs?: number;
  per_slug?: Record<string, { max_age_days?: number; max_runs?: number }>;
}

interface CronfishConfig {
  bundle_prefix: string;
  bun_path?: string;
  retention?: RetentionConfig;
}

// Default retention for a manual `cronfish prune` when nothing is configured.
// Auto-prune on sync does NOT use this — it only runs when retention is set
// explicitly, so an unconfigured repo never silently loses logs.
const DEFAULT_PRUNE_AGE_DAYS = 30;

function asRetentionInt(label: string, val: unknown): number | undefined {
  if (val === undefined) return undefined;
  if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
    throw new Error(`.cronfish.json: ${label} must be a positive integer`);
  }
  return val;
}

function parseRetention(raw: unknown): RetentionConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`.cronfish.json: retention must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const out: RetentionConfig = {
    max_age_days: asRetentionInt("retention.max_age_days", r.max_age_days),
    max_runs: asRetentionInt("retention.max_runs", r.max_runs),
  };
  if (r.per_slug !== undefined) {
    if (typeof r.per_slug !== "object" || r.per_slug === null) {
      throw new Error(`.cronfish.json: retention.per_slug must be an object`);
    }
    out.per_slug = {};
    for (const [slug, v] of Object.entries(r.per_slug as object)) {
      const o = (v ?? {}) as Record<string, unknown>;
      out.per_slug[slug] = {
        max_age_days: asRetentionInt(
          `retention.per_slug.${slug}.max_age_days`,
          o.max_age_days,
        ),
        max_runs: asRetentionInt(
          `retention.per_slug.${slug}.max_runs`,
          o.max_runs,
        ),
      };
    }
  }
  return out;
}

function loadConfig(): CronfishConfig {
  const path = join(CONSUMER_ROOT, ".cronfish.json");
  const defaultPrefix = `com.cronfish.${basename(CONSUMER_ROOT)}`;
  if (!existsSync(path)) return { bundle_prefix: defaultPrefix };
  let parsed: Partial<CronfishConfig>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CronfishConfig>;
  } catch (e) {
    throw new Error(`.cronfish.json: ${(e as Error).message}`);
  }
  const prefix = (parsed.bundle_prefix ?? "").trim() || defaultPrefix;
  if (!/^[a-zA-Z0-9_.-]+$/.test(prefix)) {
    throw new Error(
      `.cronfish.json: bundle_prefix "${prefix}" — must match [a-zA-Z0-9_.-]+`,
    );
  }
  const bunPath = (parsed.bun_path ?? "").trim() || undefined;
  if (bunPath !== undefined) {
    if (!bunPath.startsWith("/")) {
      throw new Error(
        `.cronfish.json: bun_path "${bunPath}" — must be an absolute path`,
      );
    }
    if (!existsSync(bunPath)) {
      throw new Error(
        `.cronfish.json: bun_path "${bunPath}" — file does not exist`,
      );
    }
  }
  const retention = parseRetention(parsed.retention);
  return { bundle_prefix: prefix, bun_path: bunPath, retention };
}

const CONFIG = loadConfig();
const PREFIX = CONFIG.bundle_prefix;
const BUN_PATH = CONFIG.bun_path;

function safeDispatch(
  input: string | number | undefined,
): Dispatched | { kind: "error"; msg: string } {
  try {
    return dispatchSchedule(input);
  } catch (e) {
    return { kind: "error", msg: (e as Error).message };
  }
}

// --- Verbs ---

interface LastResult {
  summary: string | null;
  finished_at: string | null;
}

function loadLastResults(slugs: string[]): Map<string, LastResult> {
  const out = new Map<string, LastResult>();
  if (slugs.length === 0) return out;
  const path = dbPath(CONSUMER_ROOT);
  if (!existsSync(path)) return out;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return out;
  }
  try {
    const rows = db
      .query<
        {
          slug: string;
          result_summary: string | null;
          finished_at: string | null;
        },
        []
      >(
        `SELECT j.slug AS slug, i.result_summary AS result_summary, i.finished_at AS finished_at
         FROM cron_invocations i
         JOIN cron_jobs j ON j.id = i.job_id
         WHERE i.id IN (
           SELECT MAX(id) FROM cron_invocations GROUP BY job_id
         )`,
      )
      .all();
    for (const r of rows) {
      out.set(r.slug, {
        summary: r.result_summary,
        finished_at: r.finished_at,
      });
    }
  } catch {
    // table may not have new columns yet; ignore
  } finally {
    db.close();
  }
  return out;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const dSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (dSec < 60) return `${dSec}s ago`;
  const dMin = Math.round(dSec / 60);
  if (dMin < 60) return `${dMin}m ago`;
  const dHr = Math.round(dMin / 60);
  if (dHr < 48) return `${dHr}h ago`;
  const dDay = Math.round(dHr / 24);
  return `${dDay}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

function cmdList(): void {
  const { jobs, errors } = discoverJobs(CRON_DIR);
  for (const e of errors) console.error(`[cronfish] ${e.path}: ${e.message}`);
  if (jobs.length === 0 && errors.length === 0) {
    console.log(
      "(no jobs in cron/) — run `cronfish init` to scaffold examples.",
    );
    return;
  }
  const p = platform();
  const installed = new Set(p.listInstalled(PREFIX));
  const isInstalled = (slug: string): boolean =>
    installed.has(p.labelSuffixOf(slug));
  const lastResults = loadLastResults(jobs.map((j) => j.slug));
  const cols = Math.max(80, Number(process.stdout.columns) || 120);
  // Reserve 80 chars for the leading columns, give the rest to "last result".
  const resultBudget = Math.max(20, cols - 80);
  const headers = [
    "slug",
    "kind",
    "schedule",
    "model",
    "enabled",
    "loaded",
    "retries",
    "concurrency",
    "last result",
  ];
  console.log(headers.join("\t"));
  for (const j of jobs) {
    const d = safeDispatch(j.schedule);
    let sched: string;
    if (d.kind === "error") {
      sched = j.enabled ? `BAD(${d.msg})` : "—";
    } else if (d.kind === "manual") {
      sched = "manual";
    } else if (d.kind === "cron") {
      sched = d.expr;
    } else {
      sched = `every ${d.value}s`;
    }
    const lr = lastResults.get(j.slug);
    let resultCell = "—";
    if (lr) {
      const when = relativeTime(lr.finished_at);
      const summary = lr.summary ?? "(no summary)";
      resultCell = truncate(`${summary} (${when})`, resultBudget);
    }
    console.log(
      [
        j.slug,
        j.kind,
        sched,
        j.model ?? "—",
        j.enabled ? "yes" : "no",
        isInstalled(j.slug) ? "yes" : "no",
        String(j.retries ?? 0),
        j.concurrency ?? "—",
        resultCell,
      ].join("\t"),
    );
  }
}

function shouldInstall(job: JobMeta): {
  ok: boolean;
  reason?: string;
  dispatched?: Dispatched;
} {
  if (!job.enabled) return { ok: false, reason: "disabled" };
  if (job.oneTime) {
    if (job.runAtMs === undefined) {
      return { ok: false, reason: "one-time: missing run_at" };
    }
    const status = resolveOneTime(
      job.runAtMs,
      job.graceSeconds ?? 0,
      Date.now(),
      job.executedAt,
    );
    if (status.kind === "executed") {
      return { ok: false, reason: "one-time: already executed" };
    }
    if (status.kind === "past-grace") {
      return { ok: false, reason: `one-time past grace: ${status.reason}` };
    }
    // fire-now and scheduled are both installable; launchd.render handles
    // the plist shape via the JobMeta.oneTime fields directly.
    return { ok: true };
  }
  let d: Dispatched;
  try {
    d = dispatchSchedule(job.schedule);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (d.kind === "manual") return { ok: false, reason: "manual" };
  return { ok: true, dispatched: d };
}

function loadRunnerNames(): Set<string> {
  const cfgPath = join(CONSUMER_ROOT, ".cronfish.json");
  if (!existsSync(cfgPath)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      runners?: Record<string, { path?: string }>;
    };
    return new Set(Object.keys(raw.runners ?? {}));
  } catch {
    return new Set();
  }
}

function cmdSync(): void {
  const p = platform();
  const { jobs, errors } = discoverJobs(CRON_DIR);
  for (const e of errors) {
    console.error(`[cronfish] ${e.path}: ${e.message}`);
    // Bad YAML / invalid run_at on a one-time file → sentinel. Any other
    // discovery error lands in the .errors folder too if it's under
    // cron/one-time/ since silent-skip is the failure mode we're killing.
    if (e.path.includes(`/${"one-time"}/`)) {
      const slug = e.path.split("/").pop() ?? "unknown";
      writeSentinel(CRON_DIR, slug, `discovery error: ${e.message}`);
    }
  }

  // Warn loudly when a .md job declares a runner that isn't registered in
  // .cronfish.json#runners. Runtime hard-fails anyway (see runner.ts), but
  // catching the typo at sync time is friendlier than at 3am.
  const knownRunners = loadRunnerNames();
  for (const j of jobs) {
    if (j.runner && !knownRunners.has(j.runner)) {
      const known = [...knownRunners].join(", ") || "(none)";
      console.error(
        `[cronfish] WARN ${j.slug}: runner "${j.runner}" not in .cronfish.json#runners — known: ${known}`,
      );
    }
  }

  const state = rememberPrefix(CONSUMER_ROOT, PREFIX);
  const desired = new Map<string, JobMeta>();
  const desiredLabels = new Set<string>();
  for (const j of jobs) {
    const decision = shouldInstall(j);
    if (decision.ok) {
      desired.set(j.slug, j);
      desiredLabels.add(p.labelSuffixOf(j.slug));
    } else if (
      decision.reason &&
      decision.reason !== "disabled" &&
      decision.reason !== "manual" &&
      decision.reason !== "one-time: already executed"
    ) {
      console.error(`[cronfish] ${j.slug}: ${decision.reason}`);
      if (j.oneTime && decision.reason?.startsWith("one-time past grace:")) {
        writeSentinel(CRON_DIR, j.slug, decision.reason);
      }
    }
  }

  // Walk every historical prefix and bootout label-suffixes no longer desired
  // under the current prefix. This is the stale-prefix fix.
  for (const prefix of state.seen_prefixes) {
    for (const labelSuffix of p.listInstalled(prefix)) {
      const stillDesired = prefix === PREFIX && desiredLabels.has(labelSuffix);
      if (stillDesired) continue;
      console.log(`[cronfish] bootout ${prefix}.${labelSuffix}`);
      p.uninstall(prefix, labelSuffix);
    }
  }

  for (const [slug, job] of desired) {
    try {
      const r = p.install(job, {
        bundlePrefix: PREFIX,
        consumerRoot: CONSUMER_ROOT,
        bunPath: BUN_PATH,
      });
      console.log(
        r.changed
          ? `[cronfish] bootstrap ${slug}`
          : `[cronfish] up-to-date ${slug}`,
      );
    } catch (e) {
      console.error(
        `[cronfish] install ${slug} failed: ${(e as Error).message}`,
      );
    }
  }

  // Ledger sync — record every discovered job (even disabled/manual) and
  // soft-delete anything no longer on disk. Failure-safe: a broken DB warns
  // once and does not abort the sync.
  try {
    const db = openDb(CONSUMER_ROOT);
    const presentSlugs: string[] = [];
    for (const j of jobs) {
      try {
        upsertJob(db, j);
        presentSlugs.push(j.slug);
      } catch (e) {
        console.error(
          `[cronfish] ledger upsert ${j.slug} failed: ${(e as Error).message}`,
        );
      }
    }
    markDeleted(db, presentSlugs);
    db.close();
  } catch (e) {
    console.error(`[cronfish] ledger sync skipped: ${(e as Error).message}`);
  }

  // Auto-prune logs — opt-in. Only runs when retention is configured, so an
  // unconfigured repo never silently loses logs on sync. Failure-safe.
  if (CONFIG.retention) {
    try {
      const { global, perSlug } = retentionToPruneInput();
      const report = pruneLogs({
        consumerRoot: CONSUMER_ROOT,
        global,
        perSlug,
      });
      if (report.totalDeleted > 0) printPruneReport(report, false);
    } catch (e) {
      console.error(`[cronfish] auto-prune skipped: ${(e as Error).message}`);
    }
  }

  console.log("[cronfish] sync complete");
}

function flipEnabled(slug: string, enabled: boolean): void {
  const path = findJobFile(CRON_DIR, slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  const raw = readFileSync(path, "utf-8");
  if (path.endsWith(".md")) {
    writeFileSync(path, setFrontmatterKey(raw, "enabled", enabled), "utf-8");
  } else if (path.endsWith(".sh")) {
    writeFileSync(
      path,
      setShellFrontmatterKey(raw, "enabled", enabled),
      "utf-8",
    );
  } else {
    writeFileSync(path, rewriteTsEnabled(raw, enabled), "utf-8");
  }
  console.log(`[cronfish] ${enabled ? "enabled" : "disabled"} ${slug}`);
  cmdSync();
}

function rewriteTsEnabled(source: string, enabled: boolean): string {
  // Scoped rewrite: only the first top-level `enabled:` inside the
  // `config = { ... }` block. Avoids matching strings/comments outside.
  const open = source.search(/\bconfig\b\s*(?::\s*[^=]+)?=\s*\{/);
  if (open < 0) {
    throw new Error("TS job has no top-level `config = { ... }` block");
  }
  const startBody = source.indexOf("{", open) + 1;
  let depth = 1;
  let i = startBody;
  let endBody = -1;
  let inStr: string | null = null;
  for (; i < source.length; i++) {
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
  if (endBody < 0) throw new Error("TS job `config` block is unbalanced");
  const head = source.slice(0, startBody);
  const body = source.slice(startBody, endBody);
  const tail = source.slice(endBody);
  const re = /\benabled\s*:\s*(true|false)/;
  const next = re.test(body)
    ? body.replace(re, `enabled: ${enabled}`)
    : `\n  enabled: ${enabled},${body}`;
  return head + next + tail;
}

function cmdDelete(slug: string, yes: boolean): void {
  const path = findJobFile(CRON_DIR, slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  if (!yes) {
    console.error(
      `refusing to delete without --yes. would delete: plist + ${path}`,
    );
    process.exit(2);
  }
  const p = platform();
  p.uninstall(PREFIX, slug);
  rmSync(path);
  console.log(`[cronfish] deleted ${slug} (plist + job file)`);
}

function cmdStatus(slug?: string): void {
  const p = platform();
  const { jobs } = discoverJobs(CRON_DIR);
  const targets = slug ? jobs.filter((j) => j.slug === slug) : jobs;
  if (!slug) {
    cmdList();
    return;
  }
  for (const j of targets) {
    console.log(`\n=== ${j.slug} (${j.kind}) ===`);
    console.log(p.statusOf(PREFIX, j.slug));
    const logDir = join(CONSUMER_ROOT, ".cronfish", "logs", j.slug);
    if (existsSync(logDir)) {
      const logs = readdirSync(logDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, m: statSync(join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (logs[0]) {
        console.log(`--- latest log: ${logs[0].f} ---`);
        console.log(
          readFileSync(join(logDir, logs[0].f), "utf-8").slice(-2000),
        );
      }
    }
  }
}

async function cmdRun(slug: string): Promise<void> {
  const path = findJobFile(CRON_DIR, slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  // Validate before spawning.
  loadJob(path, undefined, CRON_DIR);
  const runnerTs = new URL("./runner.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", runnerTs, path], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: CONSUMER_ROOT,
    env: {
      ...process.env,
      CRONFISH_CONSUMER_ROOT: CONSUMER_ROOT,
      CRONFISH_TRIGGER: "manual",
    },
  });
  process.exit(await proc.exited);
}

interface UiOptions {
  port: number;
  host: string;
  open: boolean;
}

const UI_USAGE = "usage: cronfish ui [--port N] [--host ADDR] [--no-open]";

function parseUiArgs(rest: string[]): UiOptions {
  let port = 4747;
  let host = "127.0.0.1";
  let open = true;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--no-open") open = false;
    else if (arg === "--port") {
      const next = rest[++i];
      if (!next || !/^\d+$/.test(next)) throw new Error(UI_USAGE);
      port = parseInt(next, 10);
    } else if (arg.startsWith("--port=")) {
      const v = arg.slice("--port=".length);
      if (!/^\d+$/.test(v)) throw new Error(UI_USAGE);
      port = parseInt(v, 10);
    } else if (arg === "--host") {
      const next = rest[++i];
      if (!next) throw new Error(UI_USAGE);
      host = next;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      if (!host) throw new Error(UI_USAGE);
    } else {
      throw new Error(`cronfish ui: unknown flag "${arg}"`);
    }
  }
  return { port, host, open };
}

async function cmdUi(rest: string[]): Promise<void> {
  const opts = parseUiArgs(rest);
  const url = await startUiServer({
    consumerRoot: CONSUMER_ROOT,
    port: opts.port,
    hostname: opts.host,
  });
  console.log(`[cronfish] ui at ${url}`);
  if (opts.open) {
    try {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // ignore — `open` is macOS-only, dev may be on Linux
    }
  }
  // Keep the process alive — server has its own lifecycle.
  await new Promise(() => {});
}

const UI_INSTALL_USAGE = "usage: cronfish ui install [--port N] [--host ADDR]";

function parseUiInstallArgs(rest: string[]): { port: number; host: string } {
  let port = 4747;
  let host = "127.0.0.1";
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--port") {
      const next = rest[++i];
      if (!next || !/^\d+$/.test(next)) throw new Error(UI_INSTALL_USAGE);
      port = parseInt(next, 10);
    } else if (arg.startsWith("--port=")) {
      const v = arg.slice("--port=".length);
      if (!/^\d+$/.test(v)) throw new Error(UI_INSTALL_USAGE);
      port = parseInt(v, 10);
    } else if (arg === "--host") {
      const next = rest[++i];
      if (!next) throw new Error(UI_INSTALL_USAGE);
      host = next;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      if (!host) throw new Error(UI_INSTALL_USAGE);
    } else {
      throw new Error(`cronfish ui install: unknown flag "${arg}"`);
    }
  }
  return { port, host };
}

function cmdUiInstall(rest: string[]): void {
  const { port, host } = parseUiInstallArgs(rest);
  const r = platform().installUi({
    bundlePrefix: PREFIX,
    consumerRoot: CONSUMER_ROOT,
    port,
    host,
    bunPath: BUN_PATH,
  });
  if (r.changed) {
    console.log(`[cronfish] ui installed: ${r.label}`);
    console.log(`           plist: ${r.plistPath}`);
    console.log(`           log:   ${r.logPath}`);
    console.log(`           url:   ${r.url}`);
  } else {
    console.log(`[cronfish] ui already up-to-date: ${r.url}`);
  }
}

function cmdUiUninstall(): void {
  const r = platform().uninstallUi(PREFIX);
  if (r.existed) {
    console.log(`[cronfish] ui uninstalled: ${r.label}`);
  } else {
    console.log(`[cronfish] ui not installed (${r.label})`);
  }
}

function cmdUiStatus(): void {
  const s = platform().uiStatus(PREFIX);
  if (!s.installed && !s.loaded) {
    console.log("[cronfish] ui not installed");
    console.log("           run: cronfish ui install");
    return;
  }
  console.log(
    `[cronfish] ui ${s.loaded ? "running" : "installed (not loaded)"}`,
  );
  console.log(`           label: ${s.label}`);
  console.log(`           plist: ${s.plistPath}`);
  if (s.pid !== null) console.log(`           pid:   ${s.pid}`);
  if (s.url) console.log(`           url:   ${s.url}`);
}

async function cmdWatchdog(): Promise<void> {
  const { runWatchdog } = await import("./watchdog.ts");
  const decisions = await runWatchdog({ consumerRoot: CONSUMER_ROOT });
  let fired = 0;
  let errors = 0;
  for (const d of decisions) {
    if (d.outcome === "fired") {
      fired++;
      console.log(`[watchdog] FIRED ${d.slug} (expected ${d.expected_at})`);
    } else if (d.outcome === "fire-failed") {
      errors++;
      console.error(
        `[watchdog] FAIL  ${d.slug}: ${d.error ?? "unknown"} (expected ${d.expected_at})`,
      );
    }
  }
  if (fired === 0 && errors === 0) {
    // Silent: spec says "no missed jobs and exits 0 silently".
    return;
  }
  if (errors > 0) process.exit(1);
}

async function cmdAlertsTest(adapterName?: string): Promise<void> {
  const { loadConsumerAlertsConfig, buildRegistry, safeNotify } =
    await import("./alerts/index.ts");
  const cfg = loadConsumerAlertsConfig(CONSUMER_ROOT);
  const name = adapterName ?? cfg.alerts?.default;
  if (!name) {
    console.error(
      `[cronfish] alerts test: no adapter given and alerts.default not set in .cronfish.json`,
    );
    process.exit(2);
  }
  const registry = buildRegistry(cfg.alerts);
  if (!registry.has(name)) {
    console.error(`[cronfish] alerts test: unknown adapter "${name}"`);
    process.exit(2);
  }
  const outcome = await safeNotify(registry.get(name), {
    slug: "cronfish-alerts-test",
    status: "test",
    exit_code: 0,
    duration_ms: 0,
    started_at: new Date().toISOString(),
    log_tail: "This is a cronfish alerts test ping.",
    ui_url: cfg.ui?.public_url ?? null,
  });
  if (outcome.status === "sent") {
    console.log(`[cronfish] alerts test: ${name} OK`);
    return;
  }
  console.error(`[cronfish] alerts test: ${name} FAILED — ${outcome.error}`);
  process.exit(1);
}

function cmdNext(slug?: string, n = 5): void {
  const { jobs } = discoverJobs(CRON_DIR);
  const targets = slug ? jobs.filter((j) => j.slug === slug) : jobs;
  for (const j of targets) {
    try {
      const d = dispatchSchedule(j.schedule);
      if (d.kind === "manual") {
        console.log(`${j.slug}\tmanual (no autoschedule)`);
        continue;
      }
      if (d.kind === "seconds") {
        const now = Date.now();
        const fires = Array.from({ length: n }, (_, i) =>
          new Date(now + (i + 1) * d.value * 1000).toISOString(),
        );
        console.log(`${j.slug}\tevery ${d.value}s\t→\t${fires.join(", ")}`);
        continue;
      }
      console.log(
        `${j.slug}\tcron "${d.expr}" (preview not implemented for cron)`,
      );
    } catch (e) {
      console.error(`${j.slug}: ${(e as Error).message}`);
    }
  }
}

// --- cronfish init ---

const INIT_MD = `---
description: "Demo markdown cron — prints the time"
schedule: "every 5 minutes"
model: haiku
enabled: false
timeout: 120
---

You are a cronfish demo job. Print one short sentence summarizing the current time.
This file is wired off (\`enabled: false\`) — flip it on with \`cronfish enable hello\`.
`;

const INIT_TS = `// cronfish demo job — programmable side. Disabled by default.
// Flip on with \`cronfish enable touch-ts\`.
export const config = {
  description: "Demo TS cron — appends a timestamp to tmp/touched.txt",
  schedule: "every 5 minutes",
  enabled: false,
  timeout: 60,
};

export default async function run(): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
  const out = path.join(root, "tmp", "touched.txt");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, new Date().toISOString() + "\\n", { flag: "a" });
  console.log("[touch] wrote", out);
}
`;

const INIT_SH = `#!/bin/bash
# cronfish demo job — bash side. Disabled by default.
# Flip on with \`cronfish enable ping-sh\`.
# ---
# description: "Demo bash cron — pings hello to the log"
# schedule: "every 5 minutes"
# enabled: false
# timeout: 30
# ---
set -euo pipefail
echo "[ping] hello from bash at $(date -u +%FT%TZ)"
`;

const INIT_WATCHDOG_SH = `#!/bin/bash
# Cronfish watchdog — detects missed schedules and pings the configured alert
# adapter. Safe to run frequently; one alert per missed window.
# ---
# description: "Cronfish missed-schedule watchdog"
# schedule: "every 5 minutes"
# enabled: false
# timeout: 60
# ---
set -euo pipefail
exec cronfish watchdog
`;

const GITIGNORE_BLOCK = "# cronfish\n.cronfish/\n";

function ensureGitignoreBlock(): void {
  const path = join(CONSUMER_ROOT, ".gitignore");
  let existing = "";
  if (existsSync(path)) {
    existing = readFileSync(path, "utf-8");
    if (/^\.cronfish\/?\s*$/m.test(existing)) {
      console.log(`[cronfish] init: .gitignore already ignores .cronfish/`);
      return;
    }
  }
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const next =
    existing + sep + (existing.length === 0 ? "" : "\n") + GITIGNORE_BLOCK;
  writeFileSync(path, next, "utf-8");
  console.log(`[cronfish] init: added .cronfish/ to ${path}`);
}

// Translate the .cronfish.json `retention` block into the prune core's shape.
function retentionToPruneInput(override?: SlugRetention): {
  global: SlugRetention;
  perSlug: Record<string, SlugRetention>;
} {
  const r = CONFIG.retention;
  const global: SlugRetention = override ?? {
    maxAgeDays: r?.max_age_days,
    maxRuns: r?.max_runs,
  };
  const perSlug: Record<string, SlugRetention> = {};
  // CLI flag overrides win across every slug — ignore per_slug config then.
  if (!override && r?.per_slug) {
    for (const [slug, v] of Object.entries(r.per_slug)) {
      perSlug[slug] = { maxAgeDays: v.max_age_days, maxRuns: v.max_runs };
    }
  }
  return { global, perSlug };
}

function printPruneReport(report: PruneReport, dryRun: boolean): void {
  const verb = dryRun ? "would prune" : "pruned";
  if (report.totalDeleted === 0) {
    console.log("[cronfish] prune: nothing to remove");
    return;
  }
  for (const s of report.slugs) {
    console.log(
      `[cronfish] ${verb} ${s.slug}: ${s.deleted.length} log(s), ${formatBytes(s.bytesFreed)} (kept ${s.kept})`,
    );
  }
  console.log(
    `[cronfish] ${verb} ${report.totalDeleted} log(s) total, ${formatBytes(report.totalBytes)} freed`,
  );
}

function cmdPrune(
  slug: string | undefined,
  flags: { dryRun: boolean; maxAgeDays?: number; maxRuns?: number },
): void {
  const hasFlagOverride =
    flags.maxAgeDays !== undefined || flags.maxRuns !== undefined;
  const override: SlugRetention | undefined = hasFlagOverride
    ? { maxAgeDays: flags.maxAgeDays, maxRuns: flags.maxRuns }
    : undefined;

  let { global, perSlug } = retentionToPruneInput(override);
  // Manual prune with neither config nor flags falls back to a safe default
  // so `cronfish prune` does something useful out of the box.
  if (
    global.maxAgeDays === undefined &&
    global.maxRuns === undefined &&
    Object.keys(perSlug).length === 0
  ) {
    global = { maxAgeDays: DEFAULT_PRUNE_AGE_DAYS };
    console.log(
      `[cronfish] no retention configured — using default max_age_days=${DEFAULT_PRUNE_AGE_DAYS}`,
    );
  }

  const report = pruneLogs({
    consumerRoot: CONSUMER_ROOT,
    global,
    perSlug,
    onlySlug: slug,
    dryRun: flags.dryRun,
  });
  printPruneReport(report, flags.dryRun);
}

function cmdInit(): void {
  mkdirSync(CRON_DIR, { recursive: true });
  for (const [name, content] of [
    ["hello.md", INIT_MD],
    ["touch.ts", INIT_TS],
    ["ping.sh", INIT_SH],
    ["watchdog.sh", INIT_WATCHDOG_SH],
  ] as const) {
    const p = join(CRON_DIR, name);
    if (existsSync(p)) {
      console.log(`[cronfish] init: ${p} exists — leaving alone`);
      continue;
    }
    writeFileSync(p, content, "utf-8");
    console.log(`[cronfish] init: wrote ${p}`);
  }
  ensureGitignoreBlock();
  console.log(
    "\nNext: edit cron/hello.md, cron/touch.ts, or cron/ping.sh, flip `enabled: true`, run `cronfish sync`.",
  );
}

function usage(): void {
  console.log(
    `cronfish ${VERSION} — drop a file, schedule it.

usage:
  cronfish init                       scaffold cron/hello.md + cron/touch.ts + cron/ping.sh
  cronfish list                       show every job + state
  cronfish next [slug] [N]            preview the next N fire times (default 5)
  cronfish sync                       reconcile cron/ ↔ launchd (auto-prunes logs if retention is set)
  cronfish prune [slug] [--dry-run]   delete old per-run logs per retention config
                  [--max-age-days N] [--max-runs N]   (override config; default max_age_days=30 if unset)
  cronfish enable <slug>              flip enabled, then sync
  cronfish disable <slug>             flip disabled, then sync
  cronfish delete <slug> --yes        bootout + remove plist + job file
  cronfish status [slug]              all jobs (no arg) or one slug's launchctl + log tail
  cronfish run <slug>                 invoke runner directly (no launchd)
  cronfish watchdog                   check enabled jobs for missed schedules → fire alerts
  cronfish alerts test [adapter]      send a test alert via the named (or default) adapter
  cronfish ui [--port N] [--host ADDR] [--no-open]  local web dashboard (default 127.0.0.1:4747)
  cronfish ui install [--port N] [--host ADDR]      install dashboard as a launchd daemon (auto-restart, runs at login)
  cronfish ui uninstall               bootout + remove dashboard daemon
  cronfish ui status                  show dashboard daemon state
  cronfish --version

config: <consumer>/.cronfish.json  →  { "bundle_prefix": "com.example.app",
                                       "bun_path": "/opt/homebrew/bin/bun",
                                       "retention": { "max_age_days": 30, "max_runs": 100 } }
docs:   https://github.com/goldcaddy77/cronfish
`,
  );
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      usage();
      return;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "init":
      cmdInit();
      return;
    case "list":
      cmdList();
      return;
    case "next": {
      const slug = rest[0] && /^\d+$/.test(rest[0]) ? undefined : rest[0];
      const nStr = slug ? rest[1] : rest[0];
      const n = nStr && /^\d+$/.test(nStr) ? parseInt(nStr, 10) : 5;
      cmdNext(slug, n);
      return;
    }
    case "sync":
      cmdSync();
      return;
    case "prune": {
      const valueFlags = new Set(["--max-age-days", "--max-runs"]);
      const flag = (name: string): number | undefined => {
        const i = rest.indexOf(name);
        if (i === -1) return undefined;
        const v = rest[i + 1];
        if (!v || !/^\d+$/.test(v)) {
          throw new Error(`usage: cronfish prune ${name} <positive integer>`);
        }
        return parseInt(v, 10);
      };
      // Slug = first bare arg that is neither a flag nor a flag's value.
      let slug: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (valueFlags.has(a)) {
          i++; // skip the value
          continue;
        }
        if (a.startsWith("-")) continue;
        slug = a;
        break;
      }
      cmdPrune(slug, {
        dryRun: rest.includes("--dry-run"),
        maxAgeDays: flag("--max-age-days"),
        maxRuns: flag("--max-runs"),
      });
      return;
    }
    case "enable":
      if (!rest[0]) throw new Error("usage: cronfish enable <slug>");
      flipEnabled(rest[0], true);
      return;
    case "disable":
      if (!rest[0]) throw new Error("usage: cronfish disable <slug>");
      flipEnabled(rest[0], false);
      return;
    case "delete":
      if (!rest[0]) throw new Error("usage: cronfish delete <slug> [--yes]");
      cmdDelete(rest[0], rest.includes("--yes"));
      return;
    case "status":
      cmdStatus(rest[0]);
      return;
    case "run":
      if (!rest[0]) throw new Error("usage: cronfish run <slug>");
      await cmdRun(rest[0]);
      return;
    case "watchdog":
      await cmdWatchdog();
      return;
    case "alerts": {
      if (rest[0] !== "test") {
        console.error(`[cronfish] usage: cronfish alerts test [adapter]`);
        process.exit(2);
      }
      await cmdAlertsTest(rest[1]);
      return;
    }
    case "ui": {
      const sub = rest[0];
      if (sub === "install") {
        cmdUiInstall(rest.slice(1));
        return;
      }
      if (sub === "uninstall") {
        cmdUiUninstall();
        return;
      }
      if (sub === "status") {
        cmdUiStatus();
        return;
      }
      await cmdUi(rest);
      return;
    }
    default:
      console.error(`[cronfish] unknown verb: ${verb}`);
      usage();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`[cronfish] ${(e as Error).message}`);
  process.exit(1);
});
