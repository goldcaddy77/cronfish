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
import { platform } from "./platform/index.ts";
import { loadState, rememberPrefix } from "./state.ts";

const VERSION = "0.2.0";

const CONSUMER_ROOT = process.env.CRONFISH_CONSUMER_ROOT || process.cwd();
const CRON_DIR = join(CONSUMER_ROOT, "cron");

// --- Consumer config ---

interface CronfishConfig {
  bundle_prefix: string;
  bun_path?: string;
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
  return { bundle_prefix: prefix, bun_path: bunPath };
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
  const headers = [
    "slug",
    "kind",
    "schedule",
    "model",
    "enabled",
    "loaded",
    "retries",
    "concurrency",
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
  let d: Dispatched;
  try {
    d = dispatchSchedule(job.schedule);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (d.kind === "manual") return { ok: false, reason: "manual" };
  return { ok: true, dispatched: d };
}

function cmdSync(): void {
  const p = platform();
  const { jobs, errors } = discoverJobs(CRON_DIR);
  for (const e of errors) console.error(`[cronfish] ${e.path}: ${e.message}`);

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
      decision.reason !== "manual"
    ) {
      console.error(`[cronfish] ${j.slug}: ${decision.reason}`);
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
    const logDir = join(CONSUMER_ROOT, "tmp", "cron", j.slug);
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
  loadJob(path);
  const runnerTs = new URL("./runner.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", runnerTs, path], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: CONSUMER_ROOT,
    env: { ...process.env, CRONFISH_CONSUMER_ROOT: CONSUMER_ROOT },
  });
  process.exit(await proc.exited);
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
# schedule: "every 5 minutes"
# enabled: false
# timeout: 30
# ---
set -euo pipefail
echo "[ping] hello from bash at $(date -u +%FT%TZ)"
`;

function cmdInit(): void {
  mkdirSync(CRON_DIR, { recursive: true });
  for (const [name, content] of [
    ["hello.md", INIT_MD],
    ["touch.ts", INIT_TS],
    ["ping.sh", INIT_SH],
  ] as const) {
    const p = join(CRON_DIR, name);
    if (existsSync(p)) {
      console.log(`[cronfish] init: ${p} exists — leaving alone`);
      continue;
    }
    writeFileSync(p, content, "utf-8");
    console.log(`[cronfish] init: wrote ${p}`);
  }
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
  cronfish sync                       reconcile cron/ ↔ launchd
  cronfish enable <slug>              flip enabled, then sync
  cronfish disable <slug>             flip disabled, then sync
  cronfish delete <slug> --yes        bootout + remove plist + job file
  cronfish status [slug]              all jobs (no arg) or one slug's launchctl + log tail
  cronfish run <slug>                 invoke runner directly (no launchd)
  cronfish --version

config: <consumer>/.cronfish.json  →  { "bundle_prefix": "com.example.app",
                                       "bun_path": "/opt/homebrew/bin/bun" }
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
