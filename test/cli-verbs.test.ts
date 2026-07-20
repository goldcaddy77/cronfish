import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store/index.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface Ctx {
  root: string;
  home: string;
  fakeBin: string;
  launchctlLog: string;
}

function setup(): Ctx {
  const base = mkdtempSync(join(tmpdir(), "cronfish-cli-"));
  const root = join(base, "consumer");
  const home = join(base, "home");
  const fakeBin = join(base, "fakebin");
  const launchctlLog = join(base, "launchctl.log");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  // Fake launchctl: record args, emulate `print` returning loaded when plist
  // exists (so install() doesn't think it's stale).
  const shim = `#!/usr/bin/env bash
echo "$@" >> "${launchctlLog}"
verb="$1"
if [ "$verb" = "print" ]; then
  label="\${2##*/}"
  plist="${home}/Library/LaunchAgents/\${label}.plist"
  if [ -f "$plist" ]; then
    echo "$label"
    exit 0
  fi
  exit 1
fi
exit 0
`;
  const launchctlPath = join(fakeBin, "launchctl");
  writeFileSync(launchctlPath, shim, "utf-8");
  chmodSync(launchctlPath, 0o755);
  // Bun's findBunDir checks $HOME/.bun/bin first; symlink-equivalent: just
  // copy a marker file. Simpler: ensure real bun is reachable via PATH
  // fallback (`/usr/bin/env which bun`). We prepend fakeBin and keep the
  // rest of PATH so `which bun` still resolves.
  return { root, home, fakeBin, launchctlLog };
}

function teardown(ctx: Ctx): void {
  rmSync(join(ctx.root, ".."), { recursive: true, force: true });
}

function runCli(
  ctx: Ctx,
  args: string[],
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ctx.root,
    env: {
      ...process.env,
      HOME: ctx.home,
      PATH: `${ctx.fakeBin}:${process.env.PATH}`,
      CRONFISH_CONSUMER_ROOT: ctx.root,
    },
  });
  return {
    code: proc.exitCode ?? 0,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

function writeJob(ctx: Ctx, name: string, body: string): string {
  const cron = join(ctx.root, "cron");
  mkdirSync(cron, { recursive: true });
  const p = join(cron, name);
  writeFileSync(p, body, "utf-8");
  return p;
}

function listPlists(ctx: Ctx): string[] {
  const dir = join(ctx.home, "Library", "LaunchAgents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".plist"));
}

function setPrefix(ctx: Ctx, prefix: string): void {
  writeFileSync(
    join(ctx.root, ".cronfish.json"),
    JSON.stringify({ bundle_prefix: prefix }),
  );
}

const MD_ENABLED = `---
schedule: "every 5 minutes"
enabled: true
---
hello
`;

const TS_ENABLED = `export const config = {
  schedule: "every 10 minutes",
  enabled: true,
  timeout: 60,
};
export default async function run() {}
`;

const MD_MANUAL = `---
schedule: manual
enabled: true
---
manual job
`;

describe("cli verbs (faked launchctl)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    setPrefix(ctx, "com.test.cronfish");
  });
  afterEach(() => teardown(ctx));

  test("sync installs every enabled non-manual job once", () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    writeJob(ctx, "touch.ts", TS_ENABLED);
    writeJob(ctx, "manual.md", MD_MANUAL);

    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bootstrap hello-md");
    expect(r.out).toContain("bootstrap touch-ts");

    const plists = listPlists(ctx).sort();
    expect(plists).toEqual([
      "com.test.cronfish.hello-md.plist",
      "com.test.cronfish.touch-ts.plist",
    ]);
    // No plist for the manual job.
    expect(plists).not.toContain("com.test.cronfish.manual-md.plist");
  });

  test("sync is idempotent", () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("up-to-date hello-md");
    expect(r.out).not.toContain("bootstrap hello-md");
  });

  test("sync after bundle_prefix change boots out old plists", () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello-md.plist");

    setPrefix(ctx, "com.test.changed");
    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bootout com.test.cronfish.hello-md");
    expect(r.out).toContain("bootstrap hello-md");

    const plists = listPlists(ctx);
    expect(plists).toContain("com.test.changed.hello-md.plist");
    expect(plists).not.toContain("com.test.cronfish.hello-md.plist");
  });

  test("enable flips md frontmatter and re-syncs", () => {
    const path = writeJob(
      ctx,
      "hello.md",
      MD_ENABLED.replace("enabled: true", "enabled: false"),
    );
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toHaveLength(0);

    const r = runCli(ctx, ["enable", "hello-md"]);
    expect(r.code).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("enabled: true");
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello-md.plist");
  });

  test("disable flips ts config without corrupting nested 'enabled' strings", () => {
    const tricky = `// nested config + string containing "enabled" to trap a greedy rewrite
export const config = {
  schedule: "every 5 minutes",
  enabled: true,
  notes: { description: "this job is enabled when needed" },
};
export default async function run() {
  const _msg = "enabled: false (in a string)";
}
`;
    const path = writeJob(ctx, "trap.ts", tricky);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toContain("com.test.cronfish.trap-ts.plist");

    const r = runCli(ctx, ["disable", "trap-ts"]);
    expect(r.code).toBe(0);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("enabled: false");
    // The string literal stayed intact.
    expect(after).toContain('"this job is enabled when needed"');
    expect(after).toContain('"enabled: false (in a string)"');
    expect(listPlists(ctx)).not.toContain("com.test.cronfish.trap-ts.plist");
  });

  test("delete --yes removes plist and job file", () => {
    const path = writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello-md.plist");

    const r = runCli(ctx, ["delete", "hello-md", "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(listPlists(ctx)).not.toContain("com.test.cronfish.hello-md.plist");
  });

  test("delete without --yes refuses", () => {
    const path = writeJob(ctx, "hello.md", MD_ENABLED);
    const r = runCli(ctx, ["delete", "hello-md"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test("nested slugs sync, list, and disable correctly", () => {
    mkdirSync(join(ctx.root, "cron", "email"), { recursive: true });
    writeFileSync(
      join(ctx.root, "cron", "email", "triage.ts"),
      `export const config = { schedule: "every 5 minutes", enabled: true };
export default async function run() {}
`,
    );

    const sync = runCli(ctx, ["sync"]);
    expect(sync.code).toBe(0);
    expect(sync.out).toContain("bootstrap email/triage-ts");
    expect(listPlists(ctx)).toContain("com.test.cronfish.email.triage-ts.plist");

    const list = runCli(ctx, ["list"]);
    expect(list.out).toContain("email/triage-ts");
    // loaded column should report yes (faked launchctl print returns 0).
    const row = list.out
      .split("\n")
      .find((l) => l.startsWith("email/triage-ts"));
    expect(row).toBeDefined();
    expect(row!.split("\t")).toContain("yes");

    // Idempotent.
    const sync2 = runCli(ctx, ["sync"]);
    expect(sync2.out).toContain("up-to-date email/triage-ts");

    // Disable and re-sync removes the plist.
    const dis = runCli(ctx, ["disable", "email/triage-ts"]);
    expect(dis.code).toBe(0);
    expect(listPlists(ctx)).not.toContain(
      "com.test.cronfish.email.triage-ts.plist",
    );
  });

  test("README.md anywhere under cron/ is ignored", () => {
    mkdirSync(join(ctx.root, "cron", "group"), { recursive: true });
    writeFileSync(join(ctx.root, "cron", "README.md"), "# top");
    writeFileSync(join(ctx.root, "cron", "group", "README.md"), "# group");
    writeFileSync(join(ctx.root, "cron", "group", "real.md"), MD_ENABLED);

    const list = runCli(ctx, ["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("group/real-md");
    expect(list.out).not.toMatch(/^README\b/m);
    expect(list.out).not.toMatch(/group\/README/);
  });

  test("enable/disable flips .sh frontmatter and preserves shebang + body", () => {
    const body = `#!/bin/bash
# ---
# schedule: "every 5 minutes"
# enabled: false
# timeout: 30
# ---
echo "hello from bash"
`;
    const path = writeJob(ctx, "bash-job.sh", body);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toHaveLength(0);

    const enableR = runCli(ctx, ["enable", "bash-job-sh"]);
    expect(enableR.code).toBe(0);
    const enabled = readFileSync(path, "utf-8");
    expect(enabled.startsWith("#!/bin/bash\n")).toBe(true);
    expect(enabled).toContain("# enabled: true");
    expect(enabled).toContain('echo "hello from bash"');
    expect(listPlists(ctx)).toContain("com.test.cronfish.bash-job-sh.plist");

    const disableR = runCli(ctx, ["disable", "bash-job-sh"]);
    expect(disableR.code).toBe(0);
    const disabled = readFileSync(path, "utf-8");
    expect(disabled).toContain("# enabled: false");
    expect(disabled.startsWith("#!/bin/bash\n")).toBe(true);
    expect(listPlists(ctx)).toHaveLength(0);
  });

  test("manual jobs render as manual in list and skip plist install", () => {
    writeJob(ctx, "manual.md", MD_MANUAL);
    const listR = runCli(ctx, ["list"]);
    expect(listR.code).toBe(0);
    expect(listR.out).toContain("manual");

    const syncR = runCli(ctx, ["sync"]);
    expect(syncR.code).toBe(0);
    expect(listPlists(ctx)).toHaveLength(0);
  });

  function writeOneTime(ctx: Ctx, name: string, body: string): string {
    const dir = join(ctx.root, "cron", "one-time");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, body, "utf-8");
    return p;
  }

  function errorFiles(ctx: Ctx): string[] {
    const dir = join(ctx.root, "cron", ".errors");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".txt"));
  }

  test("past-grace one-time: sentinel written once, file archived, no re-flood", () => {
    const p = writeOneTime(
      ctx,
      "expired.ts",
      `export const config = { run_at: "2020-01-01T00:00:00Z", enabled: true };
export default async function run() {}
`,
    );
    runCli(ctx, ["sync"]);
    // File archived out of cron/one-time/ so it can't be re-discovered.
    expect(existsSync(p)).toBe(false);
    expect(errorFiles(ctx)).toHaveLength(1);

    // A second sync must NOT add another sentinel (the flood we fixed).
    runCli(ctx, ["sync"]);
    expect(errorFiles(ctx)).toHaveLength(1);

    // The sentinel is run-class (durable) — survives a clean reconcile.
    const errs = runCli(ctx, ["errors"]);
    expect(errs.out).toContain("expired");
  });

  test("discovery-error sentinel self-heals once the bad file is gone", () => {
    const p = writeOneTime(
      ctx,
      "broken.ts",
      `export const config = { run_at: "not-a-real-date", enabled: true };
export default async function run() {}
`,
    );
    runCli(ctx, ["sync"]);
    expect(errorFiles(ctx)).toHaveLength(1); // sync-class discovery sentinel

    // Recurs (deduped) but does not pile up while still broken.
    runCli(ctx, ["sync"]);
    expect(errorFiles(ctx)).toHaveLength(1);

    // Fix it → next sync reaps the now-stale sync-class sentinel.
    rmSync(p);
    const r = runCli(ctx, ["sync"]);
    expect(r.out).toContain("cleared 1 resolved sentinel");
    expect(errorFiles(ctx)).toHaveLength(0);
  });

  test("errors --clear empties the sentinel folder", () => {
    writeOneTime(
      ctx,
      "expired.ts",
      `export const config = { run_at: "2020-01-01T00:00:00Z", enabled: true };
export default async function run() {}
`,
    );
    runCli(ctx, ["sync"]);
    expect(errorFiles(ctx)).toHaveLength(1);

    const clr = runCli(ctx, ["errors", "--clear"]);
    expect(clr.code).toBe(0);
    expect(clr.out).toContain("cleared 1 sentinel");
    expect(errorFiles(ctx)).toHaveLength(0);
  });

  // Write a fresh daemon heartbeat into the consumer db so the CLI's
  // liveness guard (last tick ≤ 10s old) sees a running daemon.
  async function seedLiveHeartbeat(ctx: Ctx): Promise<void> {
    const store = await openStore(ctx.root);
    await store.beatDaemonHeartbeat({
      pid: 999,
      startedAt: new Date().toISOString(),
      version: "test",
    });
    await store.close();
  }

  test("sync with a live daemon writes NO per-job plists and retires stale ones", async () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    await seedLiveHeartbeat(ctx);
    // A leftover per-job plist from v1 must be retired; the reserved ui
    // plist must survive.
    const agents = join(ctx.home, "Library", "LaunchAgents");
    writeFileSync(join(agents, "com.test.cronfish.stale-md.plist"), "<plist/>");
    writeFileSync(join(agents, "com.test.cronfish.ui.plist"), "<plist/>");
    mkdirSync(join(ctx.root, "tmp", ".cronfish"), { recursive: true });
    writeFileSync(
      join(ctx.root, "tmp", ".cronfish", "state.json"),
      JSON.stringify({ seen_prefixes: ["com.test.cronfish"] }),
    );

    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("daemon LIVE");
    expect(r.out).not.toContain("bootstrap hello-md");
    const plists = listPlists(ctx);
    expect(plists).not.toContain("com.test.cronfish.hello-md.plist");
    expect(plists).not.toContain("com.test.cronfish.stale-md.plist");
    expect(plists).toContain("com.test.cronfish.ui.plist");
  });

  test("sync with the daemon plist installed but a STALE heartbeat still stays in daemon mode", async () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    // Heartbeat exists but is old — daemon mid-restart (KeepAlive gap) or
    // wedged. The installed daemon plist alone must keep sync from
    // reinstalling per-job plists (that would double-fire on recovery).
    const store = await openStore(ctx.root);
    await store.beatDaemonHeartbeat({
      pid: 999,
      startedAt: new Date().toISOString(),
      version: "test",
    });
    store.rawHandleForTests().prepare(
      "UPDATE cron_daemon_heartbeat SET last_tick_at = $t",
    ).run({
      $t: new Date(Date.now() - 60_000).toISOString(),
    });
    await store.close();
    const agents = join(ctx.home, "Library", "LaunchAgents");
    writeFileSync(join(agents, "com.test.cronfish.daemon.plist"), "<plist/>");

    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("daemon plist installed but heartbeat NOT fresh");
    expect(r.out).not.toContain("bootstrap hello-md");
    expect(listPlists(ctx)).not.toContain("com.test.cronfish.hello-md.plist");
  });

  test("watchdog with a live daemon defers to in-daemon detection and exits 0", async () => {
    await seedLiveHeartbeat(ctx);
    const r = runCli(ctx, ["watchdog"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("daemon owns missed-run detection");
  });

  test("sub-10s schedule warns about launchd's relaunch floor", () => {
    writeJob(
      ctx,
      "fast.ts",
      `export const config = { schedule: 5, enabled: true };
export default async function run() {}
`,
    );
    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/below launchd's ~10s relaunch floor/);
  });
});
