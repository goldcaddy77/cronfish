// launchd lifecycle for THE v2 daemon (docs/v2-daemon.md §Migration).
//
// One plist, `<bundle_prefix>.daemon`, KeepAlive=true, wrapping the exact
// `cronfish daemon` foreground entry point. Install is the single-user hot
// swap: tear down every per-job plist FIRST, verify none remain loaded, then
// bootstrap the daemon and confirm its heartbeat — both modes running at once
// is impossible by construction, not by discipline.
//
// All launchctl/filesystem side effects go through an injectable io seam so
// tests drive the full sequence against stubs and a temp LaunchAgents dir.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_PATH_DIRS, findBunDir } from "./launchd.ts";

const CLI_TS = resolve(import.meta.dir, "..", "cli.ts");

// Label suffixes that are NOT per-job plists and must survive both the
// hot-swap teardown and `cronfish sync`'s stale-plist cleanup.
export const RESERVED_LABEL_SUFFIXES = new Set(["daemon", "ui"]);

export function daemonLabel(prefix: string): string {
  return `${prefix}.daemon`;
}

export interface ExecResult {
  code: number;
  out: string;
  err: string;
}

// The io seam: everything that touches launchctl or the LaunchAgents dir.
export interface DaemonServiceIo {
  launchAgentsDir: string;
  guiDomain: string; // "gui/<uid>"
  exec: (cmd: string[]) => ExecResult;
}

export function defaultIo(): DaemonServiceIo {
  const uid = process.getuid?.() ?? 501;
  return {
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    guiDomain: `gui/${uid}`,
    exec: (cmd) => {
      const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      return {
        code: proc.exitCode ?? 0,
        out: new TextDecoder().decode(proc.stdout),
        err: new TextDecoder().decode(proc.stderr),
      };
    },
  };
}

function plistPathFor(io: DaemonServiceIo, label: string): string {
  return join(io.launchAgentsDir, `${label}.plist`);
}

function isLoaded(io: DaemonServiceIo, label: string): boolean {
  const { code, out } = io.exec([
    "launchctl",
    "print",
    `${io.guiDomain}/${label}`,
  ]);
  return code === 0 && out.includes(label);
}

function bootout(io: DaemonServiceIo, label: string): void {
  const dest = plistPathFor(io, label);
  if (existsSync(dest)) {
    io.exec(["launchctl", "bootout", io.guiDomain, dest]);
  } else {
    io.exec(["launchctl", "bootout", `${io.guiDomain}/${label}`]);
  }
}

function bootstrap(io: DaemonServiceIo, dest: string): void {
  const { code, err, out } = io.exec(["launchctl", "bootstrap", io.guiDomain, dest]);
  if (code !== 0) {
    throw new Error(`launchctl bootstrap failed (${code}): ${err || out}`);
  }
}

// Every `<prefix>.*.plist` in the LaunchAgents dir that is a per-JOB plist —
// the reserved daemon/ui labels are excluded. Returns full labels.
export function listPerJobLabels(
  prefix: string,
  io: DaemonServiceIo = defaultIo(),
): string[] {
  if (!existsSync(io.launchAgentsDir)) return [];
  const dot = `${prefix}.`;
  return readdirSync(io.launchAgentsDir)
    .filter((f) => f.startsWith(dot) && f.endsWith(".plist"))
    .map((f) => f.replace(/\.plist$/, ""))
    .filter((label) => !RESERVED_LABEL_SUFFIXES.has(label.slice(dot.length)));
}

export interface DaemonPlistConfig {
  bundlePrefix: string;
  consumerRoot: string;
  bunPath?: string;
}

export function daemonLogPath(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "logs", "daemon", "daemon.log");
}

export interface DaemonRender {
  label: string;
  contents: string;
}

// Deliberately minimal EnvironmentVariables (HOME/PATH/consumer root, no
// .env embedding): the daemon spawns the runner with cwd=consumerRoot, so
// bun's .env auto-load gives every child the consumer secrets dynamically —
// no daemon reinstall on .env edits, and no secrets in the plist.
export function renderDaemonPlist(cfg: DaemonPlistConfig): DaemonRender {
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
  const label = daemonLabel(cfg.bundlePrefix);
  const logPath = daemonLogPath(cfg.consumerRoot);
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
        <string>daemon</string>
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
  return { label, contents };
}

// Structural — the caller (cli.ts) supplies a heartbeat reader over the
// consumer db; the platform layer stays db-free.
export interface HeartbeatPeek {
  last_tick_at: string;
  pid: number;
}

// A heartbeat this fresh counts as a live daemon (mirrors cli.ts's
// DAEMON_FRESH_MS — 1 Hz ticks make anything past 10s a wedge).
export const HEARTBEAT_FRESH_MS = 10_000;
const HEARTBEAT_WAIT_MS = 15_000;
const HEARTBEAT_POLL_MS = 500;

export interface InstallDaemonOpts extends DaemonPlistConfig {
  readHeartbeat: () => HeartbeatPeek | null;
  io?: DaemonServiceIo;
  heartbeatWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface InstallDaemonResult {
  label: string;
  plistPath: string;
  logPath: string;
  removedPerJob: string[];
  changed: boolean;
}

// The hot swap. Phases (each printed via `log`):
//   1. enumerate this consumer's per-job plists
//   2. bootout + remove each
//   3. verify none remain loaded (throws — never run both modes at once)
//   4. write + bootstrap the daemon plist (skipped when already up-to-date),
//      then kickstart — RunAtLoad alone can pend forever (see below)
//   5. verify the daemon heartbeat within ~15s (throws on timeout, with the
//      tail of the daemon log inlined)
// Idempotent: re-running with the daemon installed re-verifies and returns
// changed=false without a reload.
export async function installDaemon(
  opts: InstallDaemonOpts,
): Promise<InstallDaemonResult> {
  const io = opts.io ?? defaultIo();
  const log = opts.log ?? ((m: string) => console.log(m));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const label = daemonLabel(opts.bundlePrefix);
  const plistPath = plistPathFor(io, label);
  const logPath = daemonLogPath(opts.consumerRoot);

  // Phase 1 — enumerate per-job plists.
  const perJob = listPerJobLabels(opts.bundlePrefix, io);
  log(
    `[cronfish] daemon install 1/5: ${perJob.length} per-job plist(s) to retire${perJob.length ? `: ${perJob.join(", ")}` : ""}`,
  );

  // Phase 2 — bootout + remove each.
  for (const jobLabel of perJob) {
    log(`[cronfish] daemon install 2/5: bootout ${jobLabel}`);
    bootout(io, jobLabel);
    const dest = plistPathFor(io, jobLabel);
    if (existsSync(dest)) rmSync(dest);
  }

  // Phase 3 — verify none remain (loaded OR on disk).
  const remaining = perJob.filter((l) => isLoaded(io, l));
  const leftoverFiles = listPerJobLabels(opts.bundlePrefix, io);
  if (remaining.length > 0 || leftoverFiles.length > 0) {
    throw new Error(
      `daemon install: per-job plists still present after teardown — loaded: [${remaining.join(", ")}], on disk: [${leftoverFiles.join(", ")}]. Not installing the daemon (both modes at once would double-fire).`,
    );
  }
  log(`[cronfish] daemon install 3/5: per-job plists clear`);

  // Phase 4 — write + load the daemon plist (idempotent).
  mkdirSync(io.launchAgentsDir, { recursive: true });
  mkdirSync(join(opts.consumerRoot, ".cronfish", "logs", "daemon"), {
    recursive: true,
  });
  const r = renderDaemonPlist(opts);
  const prev = existsSync(plistPath) ? readFileSync(plistPath, "utf-8") : "";
  let changed: boolean;
  let reloadedAtMs: number | null = null;
  if (prev === r.contents && isLoaded(io, label)) {
    changed = false;
    log(`[cronfish] daemon install 4/5: ${label} already up-to-date and loaded`);
  } else {
    if (existsSync(plistPath)) bootout(io, label);
    writeFileSync(plistPath, r.contents, "utf-8");
    reloadedAtMs = Date.now();
    bootstrap(io, plistPath);
    changed = true;
    log(`[cronfish] daemon install 4/5: bootstrapped ${label}`);
  }

  // Kickstart — force an immediate spawn. On macOS (seen live on 25.2/Darwin,
  // gui domain) launchd can register a bootstrapped agent but never spawn it
  // despite RunAtLoad=true (`launchctl print` shows "pended nondemand spawn =
  // speculative", runs = 0) — the daemon sits idle and the heartbeat wait
  // below times out with the per-job plists already retired. Plain kickstart
  // (NO -k) is correct on every path: the re-render branch above already
  // bootout'd the old process before bootstrap (so there is no stale process
  // to kill), and on the no-op branch the healthy running daemon must NOT be
  // killed — plain kickstart is a harmless no-op there but rescues a
  // loaded-but-pended one.
  io.exec(["launchctl", "kickstart", `${io.guiDomain}/${label}`]);

  // Phase 5 — heartbeat. After a (re)load the tick must be from the NEW
  // process (last_tick_at after the bootstrap); on a no-op re-install any
  // fresh tick proves liveness.
  const waitMs = opts.heartbeatWaitMs ?? HEARTBEAT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let live = false;
  for (;;) {
    const hb = opts.readHeartbeat();
    if (hb) {
      const tickMs = Date.parse(hb.last_tick_at);
      const fresh = Date.now() - tickMs <= HEARTBEAT_FRESH_MS;
      if (fresh && (reloadedAtMs === null || tickMs >= reloadedAtMs)) {
        live = true;
        log(
          `[cronfish] daemon install 5/5: heartbeat LIVE (pid ${hb.pid}, tick ${hb.last_tick_at})`,
        );
        break;
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(HEARTBEAT_POLL_MS, waitMs));
  }
  if (!live) {
    const tail = tailLines(logPath, 5);
    throw new Error(
      `daemon install: no live heartbeat within ${Math.round(waitMs / 1000)}s — check ${logPath}${tail ? `\nlast daemon log lines:\n${tail}` : ""}`,
    );
  }

  return { label, plistPath, logPath, removedPerJob: perJob, changed };
}

// Last `n` lines of a file, "" when missing/unreadable — used to inline the
// daemon log into the heartbeat-timeout error for faster diagnosis.
function tailLines(path: string, n: number): string {
  try {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf-8").trimEnd();
    if (!text) return "";
    return text.split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

export interface UninstallDaemonOpts {
  bundlePrefix: string;
  io?: DaemonServiceIo;
  log?: (msg: string) => void;
}

export interface UninstallDaemonResult {
  existed: boolean;
  label: string;
}

export function uninstallDaemon(
  opts: UninstallDaemonOpts,
): UninstallDaemonResult {
  const io = opts.io ?? defaultIo();
  const log = opts.log ?? ((m: string) => console.log(m));
  const label = daemonLabel(opts.bundlePrefix);
  const dest = plistPathFor(io, label);
  const existed = existsSync(dest) || isLoaded(io, label);
  bootout(io, label);
  if (existsSync(dest)) rmSync(dest);
  if (existed) {
    log(`[cronfish] daemon uninstalled: ${label}`);
  } else {
    log(`[cronfish] daemon not installed (${label})`);
  }
  log(
    `[cronfish] WARNING: per-job plists are NOT restored automatically — run \`cronfish sync\` to reinstall the v1 per-job schedule.`,
  );
  return { existed, label };
}
