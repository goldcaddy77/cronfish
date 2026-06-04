#!/usr/bin/env bun
// cronfish CLI.
//   init                       — scaffold cron/ with one .md + one .ts example
//   list                       — show every job + state
//   sync                       — reconcile cron/ ↔ ~/Library/LaunchAgents/<prefix>.*
//   enable <slug>              — flip enabled, then sync
//   disable <slug>             — flip disabled, then sync
//   delete <slug> [--yes]      — bootout plist, delete plist + job file
//   status [slug]              — launchctl print + tail of latest log
//   run <slug>                 — invoke runner directly (no launchd) for testing
//
// Job spec — see README. `schedule:` is the single scheduling key; accepted
// shapes (cron / "every N units" / bare seconds / "Ns"/"Nm"/"Nh"/"Nd") are
// resolved in src/schedule.ts.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  parseFrontmatter,
  parseTsJobConfig,
  setFrontmatterKey,
} from "./frontmatter.ts";
import { dispatchSchedule } from "./schedule.ts";

const CONSUMER_ROOT = process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
const CRON_DIR = join(CONSUMER_ROOT, "cron");
const TEMPLATE = resolve(import.meta.dir, "..", "templates", "plist.template");
const LAUNCH_AGENTS = join(homedir(), "Library", "LaunchAgents");

// --- Consumer config ---

interface CronfishConfig {
  bundle_prefix: string;
}

function loadConfig(): CronfishConfig {
  const path = join(CONSUMER_ROOT, ".cronfish.json");
  const defaultPrefix = `com.cronfish.${basename(CONSUMER_ROOT)}`;
  if (!existsSync(path)) return { bundle_prefix: defaultPrefix };
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<CronfishConfig>;
    return { bundle_prefix: parsed.bundle_prefix?.trim() || defaultPrefix };
  } catch (e) {
    throw new Error(`.cronfish.json: ${(e as Error).message}`);
  }
}

const CONFIG = loadConfig();
const LABEL_PREFIX = `${CONFIG.bundle_prefix}.`;

function labelFor(slug: string): string {
  return `${LABEL_PREFIX}${slug}`;
}

function plistDest(slug: string): string {
  return join(LAUNCH_AGENTS, `${labelFor(slug)}.plist`);
}

// --- Job discovery ---

interface JobMeta {
  slug: string;
  path: string;
  kind: "md" | "ts";
  enabled: boolean;
  schedule?: string | number;
  timeout?: number;
  model?: string;
  retries?: number;
  concurrency?: string;
}

function loadJob(absPath: string): JobMeta {
  const ext = extname(absPath) as ".md" | ".ts";
  const slug = basename(absPath).replace(/\.(md|ts)$/, "");
  const raw = readFileSync(absPath, "utf-8");
  if (ext === ".md") {
    const { frontmatter } = parseFrontmatter(raw);
    return {
      slug,
      path: absPath,
      kind: "md",
      enabled: frontmatter.enabled !== false,
      schedule: frontmatter.schedule as string | number | undefined,
      timeout: frontmatter.timeout as number | undefined,
      model: (frontmatter.model as string | undefined) ?? "haiku",
      retries: frontmatter.retries as number | undefined,
      concurrency: frontmatter.concurrency as string | undefined,
    };
  }
  const cfg = parseTsJobConfig(raw);
  return {
    slug,
    path: absPath,
    kind: "ts",
    enabled: cfg.enabled !== false,
    schedule: cfg.schedule,
    timeout: cfg.timeout,
    model: cfg.model,
    retries: cfg.retries,
    concurrency: cfg.concurrency,
  };
}

function discoverJobs(): JobMeta[] {
  if (!existsSync(CRON_DIR)) return [];
  const entries = readdirSync(CRON_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".ts"))
    .map((f) => join(CRON_DIR, f));
  const jobs: JobMeta[] = [];
  for (const p of entries) {
    try {
      jobs.push(loadJob(p));
    } catch (e) {
      console.error(`[cronfish] failed to load ${p}: ${(e as Error).message}`);
    }
  }
  return jobs.sort((a, b) => a.slug.localeCompare(b.slug));
}

function findJobFile(slug: string): string | null {
  for (const ext of [".md", ".ts"]) {
    const p = join(CRON_DIR, `${slug}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

// --- Plist rendering ---

function calendarBlock(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  const [m, h, dom, mon, dow] = parts;
  const fields: [string, string][] = [
    ["Minute", m],
    ["Hour", h],
    ["Day", dom],
    ["Month", mon],
    ["Weekday", dow],
  ];
  const inner = fields
    .filter(([, v]) => v !== "*")
    .map(([k, v]) => {
      if (!/^-?\d+$/.test(v)) {
        throw new Error(
          `schedule field ${k}="${v}" not supported — only single ints or "*"`,
        );
      }
      return `        <key>${k}</key>\n        <integer>${parseInt(v, 10)}</integer>`;
    })
    .join("\n");
  return `    <key>StartCalendarInterval</key>\n    <dict>\n${inner}\n    </dict>`;
}

function intervalBlock(seconds: number): string {
  return `    <key>StartInterval</key>\n    <integer>${Math.floor(seconds)}</integer>`;
}

function renderPlist(job: JobMeta): string {
  const d = dispatchSchedule(job.schedule);
  const scheduleBlock =
    d.kind === "cron" ? calendarBlock(d.expr) : intervalBlock(d.value);
  const tmpl = readFileSync(TEMPLATE, "utf-8");
  return tmpl
    .replace(/__LABEL__/g, labelFor(job.slug))
    .replace(/__CONSUMER_ROOT__/g, CONSUMER_ROOT)
    .replace(/__HOME__/g, homedir())
    .replace(/__JOB_PATH__/g, job.path)
    .replace(/__SLUG__/g, job.slug)
    .replace("__SCHEDULE_BLOCK__", scheduleBlock);
}

// --- launchctl helpers ---

function sh(
  cmd: string[],
  opts: { check?: boolean } = {},
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(proc.stdout);
  const err = new TextDecoder().decode(proc.stderr);
  if (opts.check && proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${err || out}`,
    );
  }
  return { code: proc.exitCode ?? 0, out, err };
}

function gui(): string {
  const uid = process.getuid?.() ?? 501;
  return `gui/${uid}`;
}

function bootout(label: string): void {
  const dest = plistDest(label.replace(LABEL_PREFIX, ""));
  if (existsSync(dest)) {
    sh(["launchctl", "bootout", gui(), dest]);
  } else {
    sh(["launchctl", "bootout", `${gui()}/${label}`]);
  }
}

function bootstrap(dest: string): void {
  sh(["launchctl", "bootstrap", gui(), dest], { check: true });
}

function isLoaded(label: string): boolean {
  const { out } = sh(["launchctl", "print", `${gui()}/${label}`]);
  return out.includes(label);
}

function ensureTmpDirs(slug: string): void {
  mkdirSync(join(CONSUMER_ROOT, "tmp", "cron", slug), { recursive: true });
}

// --- Verbs ---

async function cmdList(): Promise<void> {
  const jobs = discoverJobs();
  if (jobs.length === 0) {
    console.log("(no jobs in cron/)");
    return;
  }
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  const installed = new Set(
    readdirSync(LAUNCH_AGENTS)
      .filter((f) => f.startsWith(LABEL_PREFIX) && f.endsWith(".plist"))
      .map((f) => f.replace(LABEL_PREFIX, "").replace(/\.plist$/, "")),
  );
  const header = [
    "slug",
    "kind",
    "schedule",
    "model",
    "enabled",
    "loaded",
    "retries",
    "concurrency",
  ].join("\t");
  console.log(header);
  for (const j of jobs) {
    let sched = "—";
    if (j.schedule !== undefined) {
      try {
        const d = dispatchSchedule(j.schedule);
        sched = d.kind === "cron" ? d.expr : `every ${d.value}s`;
      } catch {
        sched = `BAD(${j.schedule})`;
      }
    }
    const loaded = installed.has(j.slug) ? "yes" : "no";
    console.log(
      [
        j.slug,
        j.kind,
        sched,
        j.model ?? "—",
        j.enabled ? "yes" : "no",
        loaded,
        String(j.retries ?? 0),
        j.concurrency ?? "—",
      ].join("\t"),
    );
  }
}

async function cmdSync(): Promise<void> {
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  const jobs = discoverJobs();
  const desired = new Map(
    jobs.filter((j) => j.enabled).map((j) => [j.slug, j]),
  );
  const installed = readdirSync(LAUNCH_AGENTS)
    .filter((f) => f.startsWith(LABEL_PREFIX) && f.endsWith(".plist"))
    .map((f) => f.replace(LABEL_PREFIX, "").replace(/\.plist$/, ""));

  for (const slug of installed) {
    if (!desired.has(slug)) {
      const label = labelFor(slug);
      console.log(`[cronfish] bootout ${label}`);
      bootout(label);
      const dest = plistDest(slug);
      if (existsSync(dest)) rmSync(dest);
    }
  }

  for (const [slug, job] of desired) {
    ensureTmpDirs(slug);
    const dest = plistDest(slug);
    const next = renderPlist(job);
    const prev = existsSync(dest) ? readFileSync(dest, "utf-8") : "";
    if (prev === next && isLoaded(labelFor(slug))) {
      console.log(`[cronfish] up-to-date ${slug}`);
      continue;
    }
    if (existsSync(dest)) bootout(labelFor(slug));
    writeFileSync(dest, next, "utf-8");
    console.log(`[cronfish] bootstrap ${slug}`);
    bootstrap(dest);
  }
  console.log("[cronfish] sync complete");
}

async function flipEnabled(slug: string, enabled: boolean): Promise<void> {
  const path = findJobFile(slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  if (path.endsWith(".md")) {
    const raw = readFileSync(path, "utf-8");
    writeFileSync(path, setFrontmatterKey(raw, "enabled", enabled), "utf-8");
  } else {
    const raw = readFileSync(path, "utf-8");
    const re = /enabled\s*:\s*(true|false)/;
    const next = re.test(raw)
      ? raw.replace(re, `enabled: ${enabled}`)
      : raw.replace(/(config\s*=\s*\{)/, `$1\n\tenabled: ${enabled},`);
    writeFileSync(path, next, "utf-8");
  }
  console.log(`[cronfish] ${enabled ? "enabled" : "disabled"} ${slug}`);
  await cmdSync();
}

async function cmdDelete(slug: string, yes: boolean): Promise<void> {
  const path = findJobFile(slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  if (!yes) {
    console.error(
      `refusing to delete without --yes. would delete: plist + ${path}`,
    );
    process.exit(2);
  }
  const label = labelFor(slug);
  const dest = plistDest(slug);
  if (existsSync(dest)) {
    console.log(`[cronfish] bootout ${label}`);
    bootout(label);
  }
  if (isLoaded(label)) {
    throw new Error(`${label} is still loaded after bootout — aborting delete`);
  }
  if (existsSync(dest)) rmSync(dest);
  rmSync(path);
  console.log(`[cronfish] deleted ${slug} (plist + job file)`);
}

async function cmdStatus(slug?: string): Promise<void> {
  const jobs = discoverJobs();
  const targets = slug ? jobs.filter((j) => j.slug === slug) : jobs;
  for (const j of targets) {
    const label = labelFor(j.slug);
    console.log(`\n=== ${j.slug} (${j.kind}) ===`);
    const { out, err } = sh(["launchctl", "print", `${gui()}/${label}`]);
    console.log(out || err || "(not loaded)");
    const logDir = join(CONSUMER_ROOT, "tmp", "cron", j.slug);
    if (existsSync(logDir)) {
      const logs = readdirSync(logDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => ({ f, m: statSync(join(logDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (logs[0]) {
        console.log(`--- latest log: ${logs[0].f} ---`);
        const txt = readFileSync(join(logDir, logs[0].f), "utf-8");
        console.log(txt.slice(-2000));
      }
    }
  }
}

async function cmdRun(slug: string): Promise<void> {
  const path = findJobFile(slug);
  if (!path) throw new Error(`no job file for slug "${slug}"`);
  const runner = resolve(import.meta.dir, "runner.sh");
  const proc = Bun.spawn(["/bin/bash", runner, path], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: CONSUMER_ROOT,
    env: { ...process.env, CRONFISH_CONSUMER_ROOT: CONSUMER_ROOT },
  });
  const code = await proc.exited;
  process.exit(code);
}

// --- cronfish init ---

const INIT_MD = `---
schedule: "every 5 minutes"
model: haiku
enabled: false
timeout: 120
---

You are a cronfish demo job. Print one short sentence summarizing the current time.
This file is wired off (\`enabled: false\`) — flip it on with \`cronfish enable hello\`.
`;

const INIT_TS = `// cronfish demo job — programmable side. Disabled by default.
// Flip on with \`cronfish enable touch\`.
export const config = {
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

async function cmdInit(): Promise<void> {
  mkdirSync(CRON_DIR, { recursive: true });
  const writes: [string, string][] = [
    [join(CRON_DIR, "hello.md"), INIT_MD],
    [join(CRON_DIR, "touch.ts"), INIT_TS],
  ];
  for (const [path, content] of writes) {
    if (existsSync(path)) {
      console.log(`[cronfish] init: ${path} exists — leaving alone`);
      continue;
    }
    writeFileSync(path, content, "utf-8");
    console.log(`[cronfish] init: wrote ${path}`);
  }
  console.log(
    `\nNext: edit cron/hello.md or cron/touch.ts, flip enabled: true, then run \`cronfish sync\`.`,
  );
}

function usage(): void {
  console.error(
    `cronfish — drop a file, schedule it.

usage:
  cronfish init                       scaffold cron/hello.md + cron/touch.ts
  cronfish list                       show every job + state
  cronfish sync                       reconcile cron/ ↔ launchd
  cronfish enable <slug>              flip enabled, then sync
  cronfish disable <slug>             flip disabled, then sync
  cronfish delete <slug> --yes        bootout + remove plist + job file
  cronfish status [slug]              launchctl print + tail of latest log
  cronfish run <slug>                 invoke runner directly (no launchd)

config: <consumer>/.cronfish.json  →  { "bundle_prefix": "com.example.app" }
docs:   https://github.com/goldcaddy77/cronfish
`,
  );
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case "init":
      await cmdInit();
      break;
    case "list":
      await cmdList();
      break;
    case "sync":
      await cmdSync();
      break;
    case "enable":
      if (!rest[0]) throw new Error("usage: cronfish enable <slug>");
      await flipEnabled(rest[0], true);
      break;
    case "disable":
      if (!rest[0]) throw new Error("usage: cronfish disable <slug>");
      await flipEnabled(rest[0], false);
      break;
    case "delete":
      if (!rest[0]) throw new Error("usage: cronfish delete <slug> [--yes]");
      await cmdDelete(rest[0], rest.includes("--yes"));
      break;
    case "status":
      await cmdStatus(rest[0]);
      break;
    case "run":
      if (!rest[0]) throw new Error("usage: cronfish run <slug>");
      await cmdRun(rest[0]);
      break;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      usage();
      process.exit(verb ? 0 : 2);
      break;
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
