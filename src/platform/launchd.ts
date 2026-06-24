// launchd backend. Everything that knows about plists, launchctl, and
// ~/Library/LaunchAgents lives here. cli.ts talks to this via the Platform
// interface (see ./index.ts).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dispatchSchedule, type Dispatched } from "../schedule.ts";
import type { JobMeta } from "../jobs.ts";

const LAUNCH_AGENTS = join(homedir(), "Library", "LaunchAgents");
const TEMPLATE = resolve(
  import.meta.dir,
  "..",
  "..",
  "templates",
  "plist.template",
);
const RUNNER_TS = resolve(import.meta.dir, "..", "runner.ts");

// PATH candidates baked into every plist so `/usr/bin/env bun` works under
// launchd's minimal default PATH. Resolved bun dir gets prepended at sync.
const DEFAULT_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function gui(): string {
  const uid = process.getuid?.() ?? 501;
  return `gui/${uid}`;
}

function sh(cmd: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 0,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

// --- .env preservation ---
//
// Per spec: every plist's EnvironmentVariables block should carry the
// consumer's .env so .md/.sh runs (which don't go through bun's
// auto-loader) can still reach postgres / Linear / Slack tokens. Failure
// to parse .env is non-fatal — we surface to stderr and continue.

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1);
    // strip surrounding quotes (single or double) if balanced
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      val = trimmed.slice(1, -1);
    } else {
      // strip inline `#` comments only for unquoted values
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash);
      val = val.trim();
    }
    out[key] = val;
  }
  return out;
}

function loadConsumerEnv(consumerRoot: string): Record<string, string> {
  const path = join(consumerRoot, ".env");
  if (!existsSync(path)) return {};
  try {
    return parseDotEnv(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(
      `[cronfish] .env parse failed (${path}): ${(e as Error).message}`,
    );
    return {};
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderEnvBlock(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`        <key>${escapeXml(k)}</key>`);
    lines.push(`        <string>${escapeXml(v)}</string>`);
  }
  return lines.join("\n");
}

function calendarBlock(cronExpr: string): string {
  const [m, h, dom, mon, dow] = cronExpr.split(/\s+/);
  const fields: [string, string][] = [
    ["Minute", m],
    ["Hour", h],
    ["Day", dom],
    ["Month", mon],
    ["Weekday", dow],
  ];
  const inner = fields
    .filter(([, v]) => v !== "*")
    .map(
      ([k, v]) =>
        `        <key>${k}</key>\n        <integer>${parseInt(v, 10)}</integer>`,
    )
    .join("\n");
  return `    <key>StartCalendarInterval</key>\n    <dict>\n${inner}\n    </dict>`;
}

function intervalBlock(seconds: number): string {
  return `    <key>StartInterval</key>\n    <integer>${Math.floor(seconds)}</integer>`;
}

function scheduleBlock(d: Dispatched): string {
  if (d.kind === "cron") return calendarBlock(d.expr);
  if (d.kind === "seconds") return intervalBlock(d.value);
  throw new Error(`schedule kind "${d.kind}" should not produce a plist`);
}

function findBunDir(bunPathOverride?: string): string | null {
  // Resolve `bun` once at sync time; bake its directory into the plist's PATH.
  // Priority: explicit bun_path → $BUN_INSTALL/bin → common install dirs → PATH.
  if (bunPathOverride) {
    if (!existsSync(bunPathOverride)) return null;
    return dirname(bunPathOverride);
  }
  const bunInstall = process.env.BUN_INSTALL;
  const candidates = [
    bunInstall ? join(bunInstall, "bin") : null,
    "/opt/homebrew/bin",
    join(homedir(), ".bun", "bin"),
    "/usr/local/bin",
  ].filter((d): d is string => !!d);
  for (const dir of candidates) {
    if (existsSync(join(dir, "bun"))) return dir;
  }
  const { out, code } = sh(["/usr/bin/env", "which", "bun"]);
  if (code === 0 && out.trim()) return dirname(out.trim());
  return null;
}

export interface LaunchdRender {
  label: string;
  plistPath: string;
  contents: string;
}

export interface LaunchdConfig {
  bundlePrefix: string;
  consumerRoot: string;
  bunPath?: string;
}

// launchd labels can't contain `/`, so nested slugs (`email/triage`) get their
// separators flattened to `.` on the wire (`<prefix>.email.triage`). The
// reverse mapping isn't unique when a filename contains a literal `.`, so we
// only ever go slug → label; comparisons against the installed set happen in
// label space (see labelSuffixOf).
function slugToLabelComponent(slug: string): string {
  return slug.split("/").join(".");
}

function labelFor(prefix: string, slug: string): string {
  return `${prefix}.${slugToLabelComponent(slug)}`;
}

export function labelSuffixOf(slug: string): string {
  return slugToLabelComponent(slug);
}

function plistPathFor(label: string): string {
  return join(LAUNCH_AGENTS, `${label}.plist`);
}

function oneTimeScheduleBlock(job: JobMeta): { block: string; runAtLoad: boolean } {
  if (job.runAtMs === undefined) {
    throw new Error(`one-time job ${job.slug} missing runAtMs`);
  }
  const ageMs = Date.now() - job.runAtMs;
  if (ageMs >= -1000) {
    // Within grace — fire on bootstrap. Omit StartCalendarInterval entirely
    // so launchd doesn't repeat on the next calendar match.
    return { block: "", runAtLoad: true };
  }
  // Future — match the exact minute/hour/day/month. Annual recurrence is
  // theoretically possible but the runner's flock + executed_at guard
  // (and archive on success) prevents a second fire.
  const d = new Date(job.runAtMs);
  const inner =
    `        <key>Minute</key>\n        <integer>${d.getMinutes()}</integer>\n` +
    `        <key>Hour</key>\n        <integer>${d.getHours()}</integer>\n` +
    `        <key>Day</key>\n        <integer>${d.getDate()}</integer>\n` +
    `        <key>Month</key>\n        <integer>${d.getMonth() + 1}</integer>`;
  return {
    block: `    <key>StartCalendarInterval</key>\n    <dict>\n${inner}\n    </dict>`,
    runAtLoad: false,
  };
}

export function render(job: JobMeta, cfg: LaunchdConfig): LaunchdRender {
  const bunDir = findBunDir(cfg.bunPath);
  if (!bunDir) {
    if (cfg.bunPath) {
      throw new Error(
        `.cronfish.json bun_path "${cfg.bunPath}" not found on disk.`,
      );
    }
    throw new Error(
      "bun not found in $BUN_INSTALL/bin, /opt/homebrew/bin, ~/.bun/bin, /usr/local/bin, or PATH. Install: https://bun.sh (or set bun_path in .cronfish.json)",
    );
  }
  const pathEnv = [
    bunDir,
    ...DEFAULT_PATH_DIRS.filter((d) => d !== bunDir),
  ].join(":");
  const label = labelFor(cfg.bundlePrefix, job.slug);

  let schedBlock: string;
  let runAtLoad: boolean;
  if (job.oneTime) {
    const r = oneTimeScheduleBlock(job);
    schedBlock = r.block;
    runAtLoad = r.runAtLoad;
  } else {
    const d = dispatchSchedule(job.schedule);
    if (d.kind === "manual") {
      throw new Error(`render: ${job.slug} is manual — should not be installed`);
    }
    schedBlock = scheduleBlock(d);
    runAtLoad = false;
  }

  // Build EnvironmentVariables block: required keys + consumer .env merged
  // in. Required keys win over .env if a collision occurs (HOME etc.).
  const required: Record<string, string> = {
    HOME: homedir(),
    CRONFISH_CONSUMER_ROOT: cfg.consumerRoot,
    PATH: pathEnv,
  };
  const consumerEnv = loadConsumerEnv(cfg.consumerRoot);
  const merged: Record<string, string> = { ...consumerEnv, ...required };
  const envBlock = renderEnvBlock(merged);

  const tmpl = readFileSync(TEMPLATE, "utf-8");
  const contents = tmpl
    .replace(/__LABEL__/g, label)
    .replace(/__CONSUMER_ROOT__/g, cfg.consumerRoot)
    .replace(/__JOB_PATH__/g, job.path)
    .replace(/__SLUG__/g, job.slug)
    .replace(/__RUNNER_TS__/g, RUNNER_TS)
    .replace("__SCHEDULE_BLOCK__", schedBlock)
    .replace("__RUN_AT_LOAD__", runAtLoad ? "true" : "false")
    .replace("__ENV_BLOCK__", envBlock);
  return { label, plistPath: plistPathFor(label), contents };
}

export function listInstalled(prefix: string): string[] {
  if (!existsSync(LAUNCH_AGENTS)) return [];
  const dot = `${prefix}.`;
  return readdirSync(LAUNCH_AGENTS)
    .filter((f) => f.startsWith(dot) && f.endsWith(".plist"))
    .map((f) => f.replace(dot, "").replace(/\.plist$/, ""));
}

export function isLoaded(label: string): boolean {
  const { code, out } = sh(["launchctl", "print", `${gui()}/${label}`]);
  return code === 0 && out.includes(label);
}

function bootout(label: string): void {
  const dest = plistPathFor(label);
  if (existsSync(dest)) {
    sh(["launchctl", "bootout", gui(), dest]);
  } else {
    sh(["launchctl", "bootout", `${gui()}/${label}`]);
  }
}

function bootstrap(dest: string): void {
  const { code, err, out } = sh(["launchctl", "bootstrap", gui(), dest]);
  if (code !== 0) {
    throw new Error(`launchctl bootstrap failed (${code}): ${err || out}`);
  }
}

export interface InstallResult {
  changed: boolean;
}

export function install(job: JobMeta, cfg: LaunchdConfig): InstallResult {
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  const r = render(job, cfg);
  const prev = existsSync(r.plistPath)
    ? readFileSync(r.plistPath, "utf-8")
    : "";
  if (prev === r.contents && isLoaded(r.label)) {
    return { changed: false };
  }
  if (existsSync(r.plistPath)) bootout(r.label);
  writeFileSync(r.plistPath, r.contents, "utf-8");
  bootstrap(r.plistPath);
  return { changed: true };
}

export function uninstall(prefix: string, slug: string): boolean {
  const label = labelFor(prefix, slug);
  const dest = plistPathFor(label);
  const existed = existsSync(dest) || isLoaded(label);
  if (existsSync(dest)) bootout(label);
  if (existsSync(dest)) rmSync(dest);
  return existed;
}

export function statusOf(prefix: string, slug: string): string {
  const label = labelFor(prefix, slug);
  const { code, out, err } = sh(["launchctl", "print", `${gui()}/${label}`]);
  if (code !== 0) return "(not loaded)";
  return out || err;
}

export function getLabel(prefix: string, slug: string): string {
  return labelFor(prefix, slug);
}

// --- UI daemon (cronfish ui install/uninstall/status) ---

const CLI_TS = resolve(import.meta.dir, "..", "cli.ts");

function uiLabelFor(prefix: string): string {
  return `${prefix}.ui`;
}

export interface UiDaemonConfig {
  bundlePrefix: string;
  consumerRoot: string;
  port: number;
  host: string;
  bunPath?: string;
}

function lanIpv4(): string | null {
  const ifs = networkInterfaces();
  for (const addrs of Object.values(ifs)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

function urlFor(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::") {
    const ip = lanIpv4();
    return ip ? `http://${ip}:${port}` : `http://127.0.0.1:${port}`;
  }
  return `http://${host}:${port}`;
}

function renderUi(cfg: UiDaemonConfig): LaunchdRender {
  const bunDir = findBunDir(cfg.bunPath);
  if (!bunDir) {
    if (cfg.bunPath) {
      throw new Error(
        `.cronfish.json bun_path "${cfg.bunPath}" not found on disk.`,
      );
    }
    throw new Error(
      "bun not found in $BUN_INSTALL/bin, /opt/homebrew/bin, ~/.bun/bin, /usr/local/bin, or PATH. Install: https://bun.sh (or set bun_path in .cronfish.json)",
    );
  }
  const pathEnv = [
    bunDir,
    ...DEFAULT_PATH_DIRS.filter((d) => d !== bunDir),
  ].join(":");
  const label = uiLabelFor(cfg.bundlePrefix);
  const logPath = join(cfg.consumerRoot, ".cronfish", "logs", "ui.log");
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>bun</string>
        <string>${CLI_TS}</string>
        <string>ui</string>
        <string>--port</string>
        <string>${cfg.port}</string>
        <string>--host</string>
        <string>${cfg.host}</string>
        <string>--no-open</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${cfg.consumerRoot}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${logPath}</string>

    <key>StandardErrorPath</key>
    <string>${logPath}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homedir()}</string>
        <key>CRONFISH_CONSUMER_ROOT</key>
        <string>${cfg.consumerRoot}</string>
        <key>PATH</key>
        <string>${pathEnv}</string>
    </dict>
</dict>
</plist>
`;
  return { label, plistPath: plistPathFor(label), contents };
}

export interface UiInstallResult {
  changed: boolean;
  label: string;
  plistPath: string;
  logPath: string;
  url: string;
}

export function installUi(cfg: UiDaemonConfig): UiInstallResult {
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  mkdirSync(join(cfg.consumerRoot, ".cronfish", "logs"), { recursive: true });
  const r = renderUi(cfg);
  const logPath = join(cfg.consumerRoot, ".cronfish", "logs", "ui.log");
  const url = urlFor(cfg.host, cfg.port);
  const prev = existsSync(r.plistPath)
    ? readFileSync(r.plistPath, "utf-8")
    : "";
  if (prev === r.contents && isLoaded(r.label)) {
    return {
      changed: false,
      label: r.label,
      plistPath: r.plistPath,
      logPath,
      url,
    };
  }
  if (existsSync(r.plistPath)) bootout(r.label);
  writeFileSync(r.plistPath, r.contents, "utf-8");
  bootstrap(r.plistPath);
  return {
    changed: true,
    label: r.label,
    plistPath: r.plistPath,
    logPath,
    url,
  };
}

export function uninstallUi(prefix: string): {
  existed: boolean;
  label: string;
} {
  const label = uiLabelFor(prefix);
  const dest = plistPathFor(label);
  const existed = existsSync(dest) || isLoaded(label);
  if (existsSync(dest)) bootout(label);
  if (existsSync(dest)) rmSync(dest);
  return { existed, label };
}

export interface UiStatusInfo {
  installed: boolean;
  loaded: boolean;
  label: string;
  plistPath: string;
  pid: number | null;
  url: string | null;
}

function parsePlistHostPort(
  plistPath: string,
): { host: string; port: number } | null {
  if (!existsSync(plistPath)) return null;
  const xml = readFileSync(plistPath, "utf-8");
  const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const portIdx = args.indexOf("--port");
  const hostIdx = args.indexOf("--host");
  const portStr = portIdx >= 0 ? args[portIdx + 1] : null;
  const host = hostIdx >= 0 ? args[hostIdx + 1] : "127.0.0.1";
  if (!portStr || !/^\d+$/.test(portStr)) return null;
  return { host, port: parseInt(portStr, 10) };
}

export function uiStatus(prefix: string): UiStatusInfo {
  const label = uiLabelFor(prefix);
  const plistPath = plistPathFor(label);
  const installed = existsSync(plistPath);
  const { code, out } = sh(["launchctl", "print", `${gui()}/${label}`]);
  const loaded = code === 0 && out.includes(label);
  let pid: number | null = null;
  if (loaded) {
    const m = out.match(/\bpid\s*=\s*(\d+)/);
    if (m) pid = parseInt(m[1], 10);
  }
  const hp = parsePlistHostPort(plistPath);
  const url = hp ? urlFor(hp.host, hp.port) : null;
  return { installed, loaded, label, plistPath, pid, url };
}
