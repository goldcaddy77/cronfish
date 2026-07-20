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
import {
  archiveOneTime,
  clearSentinels,
  listSentinels,
  reapStaleSentinels,
  resolveOneTime,
  writeSentinel,
} from "./oneTime.ts";
import {
  defaultBundlePrefix,
  parseRetention,
  retentionToPrune,
  type RetentionConfig,
} from "./config.ts";
import { platform } from "./platform/index.ts";
import {
  RESERVED_LABEL_SUFFIXES,
  installDaemon,
  uninstallDaemon,
} from "./platform/daemon-launchd.ts";
import { loadState, rememberPrefix } from "./state.ts";
import {
  dbPath,
  openStore,
  tryOpenStore,
  type DaemonHeartbeatRow,
} from "./store/index.ts";
import {
  formatBytes,
  ledgerPruneTotal,
  pruneLogs,
  type LedgerPruneReport,
  type PruneReport,
  type SlugRetention,
} from "./prune.ts";
import { startUiServer } from "./ui/server.ts";
import pkg from "../package.json" with { type: "json" };

// Single source of truth: package.json. semantic-release bumps it on release,
// so `cronfish --version` can never drift from the published version again.
const VERSION = pkg.version;

const CONSUMER_ROOT = process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
const CRON_DIR = join(CONSUMER_ROOT, "cron");

// --- Consumer config ---

interface CronfishConfig {
  bundle_prefix: string;
  bun_path?: string;
  retention?: RetentionConfig;
}

// Default retention for a manual `cronfish prune` when nothing is configured.
// Auto-prune on sync does NOT use this — it only runs when retention is set
// explicitly, so an unconfigured repo never silently loses logs.
const DEFAULT_PRUNE_AGE_DAYS = 30;

function loadConfig(): CronfishConfig {
  const path = join(CONSUMER_ROOT, ".cronfish.json");
  const defaultPrefix = defaultBundlePrefix(CONSUMER_ROOT);
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

async function loadLastResults(
  slugs: string[],
): Promise<Map<string, LastResult>> {
  const out = new Map<string, LastResult>();
  if (slugs.length === 0) return out;
  // Read-only peek — must stay side-effect free (never create .cronfish/ or
  // migrate) on a fresh consumer, same as peekHeartbeat.
  if (!existsSync(dbPath(CONSUMER_ROOT))) return out;
  const store = await tryOpenStore(CONSUMER_ROOT, { readonly: true });
  if (!store) return out;
  try {
    const rows = await store.getLastResults();
    for (const r of rows) {
      out.set(r.slug, {
        summary: r.result_summary,
        finished_at: r.finished_at,
      });
    }
  } catch {
    // table may not have new columns yet; ignore
  } finally {
    await store.close();
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

async function cmdList(): Promise<void> {
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
  const lastResults = await loadLastResults(jobs.map((j) => j.slug));
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

async function cmdSync(): Promise<void> {
  const p = platform();
  // Daemon guard: in daemon mode, per-job plists are retired — creating
  // them would double-fire every job. Sync then only updates the DB metadata
  // (the daemon's file scan re-syncs cron/ every tick anyway) and removes
  // any lingering per-job plists. The guard gates on the daemon PLIST being
  // installed OR a fresh heartbeat — never heartbeat alone: a momentarily
  // stale heartbeat (blocking alert send, KeepAlive restart gap) with the
  // daemon still installed must NOT flip sync back to per-job plists.
  const daemonHb = await liveHeartbeat();
  const daemonMode = daemonHb !== null || daemonPlistInstalled();
  if (daemonHb) {
    console.log(
      `[cronfish] daemon LIVE (pid ${daemonHb.pid}) — daemon mode: skipping per-job plist install (the daemon picks up cron/ edits automatically); updating ledger metadata only`,
    );
  } else if (daemonMode) {
    console.log(
      `[cronfish] daemon plist installed but heartbeat NOT fresh — staying in daemon mode (no per-job plists; a restart gap must not double-fire). Check \`cronfish status\` / the daemon log if this persists.`,
    );
  }
  const { jobs, errors } = discoverJobs(CRON_DIR);
  // "sync"-class sentinel filenames written this run. Anything still on disk
  // from a prior sync that ISN'T in here gets reaped at the end (self-heal).
  const writtenSentinels = new Set<string>();
  for (const e of errors) {
    console.error(`[cronfish] ${e.path}: ${e.message}`);
    // Bad YAML / invalid run_at on a one-time file → sentinel. Any other
    // discovery error lands in the .errors folder too if it's under
    // cron/one-time/ since silent-skip is the failure mode we're killing.
    if (e.path.includes(`/${"one-time"}/`)) {
      const slug = e.path.split("/").pop() ?? "unknown";
      const written = writeSentinel(
        CRON_DIR,
        slug,
        `discovery error: ${e.message}`,
        "sync",
      );
      writtenSentinels.add(basename(written));
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
    // launchd enforces a ~10s floor between relaunches (its implicit
    // ThrottleInterval). A faster `schedule:` silently fires no quicker than
    // every 10s, so warn rather than let it look like it works. Moot in
    // daemon mode — the 1s tick loop handles sub-10s schedules fine.
    const d = safeDispatch(j.schedule);
    if (!daemonMode && d.kind === "seconds" && d.value < 10) {
      console.error(
        `[cronfish] WARN ${j.slug}: schedule ${d.value}s is below launchd's ~10s relaunch floor — it will fire no faster than every 10s`,
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
        // A past-grace one-time file would otherwise be re-discovered on
        // EVERY sync and re-write a sentinel forever. Record one durable
        // ("run"-class, never reaped) sentinel so the missed window is
        // visible, then archive the file out of cron/one-time/ so it stops
        // recurring.
        writeSentinel(CRON_DIR, j.slug, decision.reason, "run");
        try {
          const dest = archiveOneTime(j.path);
          console.error(`[cronfish] ${j.slug}: archived past-grace one-time → ${dest}`);
        } catch (e) {
          console.error(
            `[cronfish] ${j.slug}: archive of past-grace one-time failed: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  // Walk every historical prefix and bootout label-suffixes no longer desired
  // under the current prefix. This is the stale-prefix fix. The reserved
  // daemon/ui labels are never per-job plists — leave them alone under the
  // current prefix. In daemon mode NOTHING per-job is desired, so any
  // lingering per-job plist gets removed here (double-fire protection).
  for (const prefix of state.seen_prefixes) {
    for (const labelSuffix of p.listInstalled(prefix)) {
      if (prefix === PREFIX && RESERVED_LABEL_SUFFIXES.has(labelSuffix)) {
        continue;
      }
      const stillDesired =
        !daemonMode && prefix === PREFIX && desiredLabels.has(labelSuffix);
      if (stillDesired) continue;
      console.log(`[cronfish] bootout ${prefix}.${labelSuffix}`);
      p.uninstall(prefix, labelSuffix);
    }
  }

  if (!daemonMode) {
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
  }

  // Ledger sync — record every discovered job (even disabled/manual) and
  // soft-delete anything no longer on disk. Failure-safe: a broken DB warns
  // once and does not abort the sync.
  try {
    const store = await openStore(CONSUMER_ROOT);
    const presentSlugs: string[] = [];
    for (const j of jobs) {
      try {
        await store.upsertJob(j);
        presentSlugs.push(j.slug);
      } catch (e) {
        console.error(
          `[cronfish] ledger upsert ${j.slug} failed: ${(e as Error).message}`,
        );
      }
    }
    await store.markDeleted(presentSlugs);
    await store.close();
  } catch (e) {
    console.error(`[cronfish] ledger sync skipped: ${(e as Error).message}`);
  }

  // Auto-prune logs + ledger rows — opt-in. Only runs when retention is
  // configured, so an unconfigured repo never silently loses history on sync.
  // Failure-safe.
  if (CONFIG.retention) {
    try {
      const { global, perSlug } = retentionToPruneInput();
      const report = pruneLogs({
        consumerRoot: CONSUMER_ROOT,
        global,
        perSlug,
      });
      if (report.totalDeleted > 0) printPruneReport(report, false);
      printLedgerReport(await pruneLedgerRows(global, perSlug), false);
    } catch (e) {
      console.error(`[cronfish] auto-prune skipped: ${(e as Error).message}`);
    }
  }

  // Self-heal: drop any "sync"-class sentinel that was NOT re-written this
  // run (its error no longer occurs). "run"-class + foreign files survive.
  const reaped = reapStaleSentinels(CRON_DIR, writtenSentinels);
  if (reaped > 0) console.log(`[cronfish] cleared ${reaped} resolved sentinel(s)`);

  console.log("[cronfish] sync complete");
}

async function flipEnabled(slug: string, enabled: boolean): Promise<void> {
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
  await cmdSync();
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

// A daemon is "live" when its last tick is at most this old. 1 Hz ticks make
// anything past 10s a wedge or a dead process.
const DAEMON_FRESH_MS = 10_000;

// Read-only heartbeat peek — never creates .cronfish/ or migrates (status on
// a fresh consumer must stay side-effect free, same as loadLastResults).
async function peekHeartbeat(): Promise<DaemonHeartbeatRow | null> {
  if (!existsSync(dbPath(CONSUMER_ROOT))) return null;
  const store = await tryOpenStore(CONSUMER_ROOT, { readonly: true });
  if (!store) return null;
  try {
    return await store.getDaemonHeartbeat();
  } catch {
    return null; // pre-v6 db — no heartbeat table yet
  } finally {
    await store.close();
  }
}

// Daemon-mode signal #2: the daemon plist sitting in LaunchAgents. A stale
// heartbeat alone must never flip sync back to per-job plists — the daemon
// may just be mid-restart (KeepAlive gap) or wedged on a blocking alert
// send, and reinstalling per-job plists then would double-fire every job.
function daemonPlistInstalled(): boolean {
  try {
    return platform().listInstalled(PREFIX).includes("daemon");
  } catch {
    return false;
  }
}

// The daemon-mode guard shared by sync / watchdog: the heartbeat, but only
// when it's fresh enough to prove a live daemon.
async function liveHeartbeat(): Promise<DaemonHeartbeatRow | null> {
  const hb = await peekHeartbeat();
  if (!hb) return null;
  const ageMs = Date.now() - Date.parse(hb.last_tick_at);
  return ageMs <= DAEMON_FRESH_MS ? hb : null;
}

async function printDaemonLiveness(): Promise<void> {
  const hb = await peekHeartbeat();
  if (!hb) {
    console.log("[cronfish] daemon: not running (no heartbeat)");
    return;
  }
  const ageMs = Date.now() - Date.parse(hb.last_tick_at);
  const live = ageMs <= DAEMON_FRESH_MS;
  console.log(
    `[cronfish] daemon: ${live ? "LIVE" : "STALE"} pid=${hb.pid} last tick ${relativeTime(hb.last_tick_at)} (tick #${hb.tick_count}${hb.version ? `, v${hb.version}` : ""})`,
  );
}

async function cmdStatus(slug?: string): Promise<void> {
  const p = platform();
  const { jobs } = discoverJobs(CRON_DIR);
  const targets = slug ? jobs.filter((j) => j.slug === slug) : jobs;
  if (!slug) {
    await printDaemonLiveness();
    await cmdList();
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

// How long `cron run` waits for a live daemon to pick the request up and
// link the invocation before handing back a "still queued" message.
const RUN_POLL_TOTAL_MS = 15_000;
const RUN_POLL_STEP_MS = 300;

// Queue the run through a live daemon ("the daemon is THE runner"). Returns
// false when there is no fresh heartbeat — caller falls back to the v1
// direct-spawn path so nothing breaks pre-migration.
async function tryRunViaDaemon(slug: string, path: string): Promise<boolean> {
  const store = await tryOpenStore(CONSUMER_ROOT);
  if (!store) return false;
  try {
    const hb = await store.getDaemonHeartbeat();
    const fresh =
      hb !== null && Date.now() - Date.parse(hb.last_tick_at) <= DAEMON_FRESH_MS;
    if (!fresh) return false;
    let jobId = await store.getJobIdBySlug(slug);
    if (jobId === null) {
      // Brand-new file the daemon hasn't ticked over yet — seed the row.
      await store.upsertJob(loadJob(path, slug, CRON_DIR));
      jobId = await store.getJobIdBySlug(slug);
    }
    if (jobId === null) return false;
    const reqId = await store.insertRunRequest(jobId);
    console.log(
      `[cronfish] run request #${reqId} queued for daemon (pid ${hb!.pid})`,
    );
    const deadline = Date.now() + RUN_POLL_TOTAL_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(RUN_POLL_STEP_MS);
      const req = await store.getRunRequest(reqId);
      if (req?.invocation_id) {
        const logPath = await store.getInvocationLogPath(req.invocation_id);
        console.log(`[cronfish] invocation ${req.invocation_id} started`);
        if (logPath) console.log(`[cronfish] log: ${logPath}`);
        return true;
      }
    }
    console.log(
      `[cronfish] request #${reqId} queued but not yet linked — check \`cronfish history ${slug}\``,
    );
    return true;
  } finally {
    await store.close();
  }
}

async function cmdRun(slug: string): Promise<void> {
  const path = findJobFile(CRON_DIR, slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  // Validate before spawning.
  loadJob(path, undefined, CRON_DIR);
  try {
    if (await tryRunViaDaemon(slug, path)) return;
  } catch (e) {
    console.error(
      `[cronfish] daemon run path failed (${(e as Error).message}) — falling back to direct spawn`,
    );
  }
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

// --- daemon + reporting verbs ---

async function cmdDaemon(): Promise<void> {
  // Foreground tick loop. `cronfish daemon install` (launchd KeepAlive)
  // wraps exactly this entry point.
  const { runDaemon } = await import("./daemon.ts");
  await runDaemon({ consumerRoot: CONSUMER_ROOT });
}

// The hot swap (docs/v2-daemon.md §Migration): retire every per-job plist,
// verify none remain, load the one daemon plist, confirm its heartbeat.
async function cmdDaemonInstall(): Promise<void> {
  const r = await installDaemon({
    bundlePrefix: PREFIX,
    consumerRoot: CONSUMER_ROOT,
    bunPath: BUN_PATH,
    readHeartbeat: peekHeartbeat,
  });
  console.log(
    r.changed
      ? `[cronfish] daemon installed: ${r.label}`
      : `[cronfish] daemon already up-to-date: ${r.label}`,
  );
  console.log(`           plist: ${r.plistPath}`);
  console.log(`           log:   ${r.logPath}`);
}

function cmdDaemonUninstall(): void {
  uninstallDaemon({ bundlePrefix: PREFIX });
}

// "--since 7d" style windows: N + s/m/h/d, anchored at now.
function parseSince(spec: string): string {
  const m = spec.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new Error(
      `--since must look like 30m, 12h, or 7d — got "${spec}"`,
    );
  }
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    m[2] as "s" | "m" | "h" | "d"
  ];
  return new Date(Date.now() - parseInt(m[1]!, 10) * mult).toISOString();
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

function fmtStamp(iso: string | null): string {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19);
}

interface ReportFlags {
  slug?: string;
  limit?: number;
  sinceIso?: string;
}

function parseReportArgs(rest: string[], usage: string): ReportFlags {
  const out: ReportFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--limit" || a.startsWith("--limit=")) {
      const v = a.includes("=") ? a.slice("--limit=".length) : rest[++i];
      if (!v || !/^\d+$/.test(v)) throw new Error(usage);
      out.limit = parseInt(v, 10);
    } else if (a === "--since" || a.startsWith("--since=")) {
      const v = a.includes("=") ? a.slice("--since=".length) : rest[++i];
      if (!v) throw new Error(usage);
      out.sinceIso = parseSince(v);
    } else if (a.startsWith("-")) {
      throw new Error(usage);
    } else if (out.slug === undefined) {
      out.slug = a;
    } else {
      throw new Error(usage);
    }
  }
  return out;
}

const HISTORY_USAGE =
  "usage: cronfish history [slug] [--limit N] [--since 7d]";

async function cmdHistory(rest: string[]): Promise<void> {
  const flags = parseReportArgs(rest, HISTORY_USAGE);
  const store = await openStore(CONSUMER_ROOT);
  try {
    const rows = await store.listRunHistory({
      slug: flags.slug,
      limit: flags.limit,
      sinceIso: flags.sinceIso,
    });
    if (rows.length === 0) {
      console.log("(no runs recorded)");
      return;
    }
    const cols = Math.max(80, Number(process.stdout.columns) || 120);
    const resultBudget = Math.max(20, cols - 90);
    console.log(
      ["started", "slug", "trigger", "status", "duration", "attempt", "result"].join(
        "\t",
      ),
    );
    for (const r of rows) {
      console.log(
        [
          fmtStamp(r.started_at),
          r.slug,
          r.trigger,
          r.status,
          fmtDuration(r.duration_ms),
          String(r.attempt),
          r.result_summary ? truncate(r.result_summary, resultBudget) : "—",
        ].join("\t"),
      );
    }
  } finally {
    await store.close();
  }
}

const STATS_USAGE = "usage: cronfish stats [--since 30d]";

async function cmdStats(rest: string[]): Promise<void> {
  const flags = parseReportArgs(rest, STATS_USAGE);
  if (flags.slug !== undefined || flags.limit !== undefined) {
    throw new Error(STATS_USAGE);
  }
  const store = await openStore(CONSUMER_ROOT);
  try {
    const rows = await store.jobStats({ sinceIso: flags.sinceIso });
    if (rows.length === 0) {
      console.log("(no runs recorded)");
      return;
    }
    console.log(
      [
        "job",
        "runs",
        "ok",
        "fail",
        "timeout",
        "success",
        "avg",
        "p95",
        "last run",
        "last status",
      ].join("\t"),
    );
    for (const r of rows) {
      console.log(
        [
          r.slug,
          String(r.runs),
          String(r.ok),
          String(r.fail),
          String(r.timeout),
          r.success_rate === null
            ? "—"
            : `${Math.round(r.success_rate * 100)}%`,
          fmtDuration(r.avg_duration_ms === null ? null : Math.round(r.avg_duration_ms)),
          fmtDuration(r.p95_duration_ms),
          relativeTime(r.last_run_at),
          r.last_status ?? "—",
        ].join("\t"),
      );
    }
  } finally {
    await store.close();
  }
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
  // Daemon guard: a live daemon runs missed-run detection in-process (same
  // decision logic, same dedup table) — the standalone verb firing too would
  // double-alert. Kept working for v1 consumers with no daemon.
  const hb = await liveHeartbeat();
  if (hb) {
    console.log(
      `[cronfish] daemon LIVE (pid ${hb.pid}) — the daemon owns missed-run detection; standalone watchdog skipped`,
    );
    return;
  }
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
  // CLI flag overrides win across every slug — ignore per_slug config then.
  if (override) return { global: override, perSlug: {} };
  return retentionToPrune(CONFIG.retention ?? {});
}

// Ledger rows (invocations, run requests, missed alerts) age out on the same
// window as logs. Failure-safe: a missing/locked db never breaks prune. A
// consumer with no db yet has no rows to prune — never create one here.
async function pruneLedgerRows(
  global: SlugRetention,
  perSlug: Record<string, SlugRetention>,
  opts: { onlySlug?: string; dryRun?: boolean } = {},
): Promise<LedgerPruneReport | null> {
  if (!existsSync(dbPath(CONSUMER_ROOT))) return null;
  const store = await openStore(CONSUMER_ROOT);
  try {
    return await store.pruneLedger({
      global,
      perSlug,
      onlySlug: opts.onlySlug,
      dryRun: opts.dryRun,
    });
  } finally {
    await store.close();
  }
}

function printLedgerReport(
  report: LedgerPruneReport | null,
  dryRun: boolean,
): void {
  if (!report || ledgerPruneTotal(report) === 0) return;
  const verb = dryRun ? "would prune" : "pruned";
  console.log(
    `[cronfish] ${verb} ledger rows: ${report.invocations} invocation(s), ${report.runRequests} run request(s), ${report.missedAlerts} missed alert(s)`,
  );
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

async function cmdPrune(
  slug: string | undefined,
  flags: { dryRun: boolean; maxAgeDays?: number; maxRuns?: number },
): Promise<void> {
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
  printLedgerReport(
    await pruneLedgerRows(global, perSlug, {
      onlySlug: slug,
      dryRun: flags.dryRun,
    }),
    flags.dryRun,
  );
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

function cmdErrors(clear: boolean, slug?: string): void {
  if (clear) {
    const n = clearSentinels(CRON_DIR, slug);
    console.log(
      `[cronfish] cleared ${n} sentinel(s)${slug ? ` for ${slug}` : ""}`,
    );
    return;
  }
  const files = listSentinels(CRON_DIR);
  if (files.length === 0) {
    console.log("[cronfish] no error sentinels");
    return;
  }
  console.log(
    `[cronfish] ${files.length} error sentinel(s) in cron/.errors/ (clear with \`cronfish errors --clear\`):\n`,
  );
  for (const f of files.sort()) {
    const body = readFileSync(join(CRON_DIR, ".errors", f), "utf-8").trim();
    console.log(`--- ${f} ---\n${body}\n`);
  }
}

function usage(): void {
  console.log(
    `cronfish ${VERSION} — drop a file, schedule it.

usage:
  cronfish init                       scaffold cron/hello.md + cron/touch.ts + cron/ping.sh
  cronfish list                       show every job + state
  cronfish next [slug] [N]            preview the next N fire times (default 5)
  cronfish sync                       reconcile cron/ ↔ launchd (auto-prunes logs + ledger rows if retention is set)
  cronfish prune [slug] [--dry-run]   delete old per-run logs + ledger rows per retention config
                  [--max-age-days N] [--max-runs N]   (override config; default max_age_days=30 if unset)
  cronfish enable <slug>              flip enabled, then sync
  cronfish disable <slug>             flip disabled, then sync
  cronfish delete <slug> --yes        bootout + remove plist + job file
  cronfish status [slug]              all jobs (no arg) or one slug's launchctl + log tail
  cronfish errors [--clear] [slug]    list error sentinels (cron/.errors/); --clear removes them
  cronfish run <slug>                 run now — queues through a live daemon, else spawns the runner directly
  cronfish daemon                     run the v2 scheduler daemon in the foreground (1s tick loop)
  cronfish daemon install             hot-swap: retire per-job plists, install the KeepAlive daemon plist
  cronfish daemon uninstall           bootout + remove the daemon plist (per-job plists NOT restored — run sync)
  cronfish history [slug] [--limit N] [--since 7d]   run timeline: started, trigger, status, duration, result
  cronfish stats [--since 30d]        per-job rollup: runs, success %, avg/p95 duration, last status
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
      await cmdList();
      return;
    case "next": {
      const slug = rest[0] && /^\d+$/.test(rest[0]) ? undefined : rest[0];
      const nStr = slug ? rest[1] : rest[0];
      const n = nStr && /^\d+$/.test(nStr) ? parseInt(nStr, 10) : 5;
      cmdNext(slug, n);
      return;
    }
    case "sync":
      await cmdSync();
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
      await cmdPrune(slug, {
        dryRun: rest.includes("--dry-run"),
        maxAgeDays: flag("--max-age-days"),
        maxRuns: flag("--max-runs"),
      });
      return;
    }
    case "enable":
      if (!rest[0]) throw new Error("usage: cronfish enable <slug>");
      await flipEnabled(rest[0], true);
      return;
    case "disable":
      if (!rest[0]) throw new Error("usage: cronfish disable <slug>");
      await flipEnabled(rest[0], false);
      return;
    case "delete":
      if (!rest[0]) throw new Error("usage: cronfish delete <slug> [--yes]");
      cmdDelete(rest[0], rest.includes("--yes"));
      return;
    case "status":
      await cmdStatus(rest[0]);
      return;
    case "errors": {
      const clear = rest.includes("--clear");
      const slug = rest.find((a) => !a.startsWith("-"));
      cmdErrors(clear, slug);
      return;
    }
    case "run":
      if (!rest[0]) throw new Error("usage: cronfish run <slug>");
      await cmdRun(rest[0]);
      return;
    case "daemon": {
      const sub = rest[0];
      if (sub === "install") {
        await cmdDaemonInstall();
        return;
      }
      if (sub === "uninstall") {
        cmdDaemonUninstall();
        return;
      }
      if (sub !== undefined) {
        throw new Error("usage: cronfish daemon [install|uninstall]");
      }
      await cmdDaemon();
      return;
    }
    case "history":
      await cmdHistory(rest);
      return;
    case "stats":
      await cmdStats(rest);
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
