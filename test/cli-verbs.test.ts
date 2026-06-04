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
    expect(r.out).toContain("bootstrap hello");
    expect(r.out).toContain("bootstrap touch");

    const plists = listPlists(ctx).sort();
    expect(plists).toEqual([
      "com.test.cronfish.hello.plist",
      "com.test.cronfish.touch.plist",
    ]);
    // No plist for the manual job.
    expect(plists).not.toContain("com.test.cronfish.manual.plist");
  });

  test("sync is idempotent", () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("up-to-date hello");
    expect(r.out).not.toContain("bootstrap hello");
  });

  test("sync after bundle_prefix change boots out old plists", () => {
    writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello.plist");

    setPrefix(ctx, "com.test.changed");
    const r = runCli(ctx, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("bootout com.test.cronfish.hello");
    expect(r.out).toContain("bootstrap hello");

    const plists = listPlists(ctx);
    expect(plists).toContain("com.test.changed.hello.plist");
    expect(plists).not.toContain("com.test.cronfish.hello.plist");
  });

  test("enable flips md frontmatter and re-syncs", () => {
    const path = writeJob(
      ctx,
      "hello.md",
      MD_ENABLED.replace("enabled: true", "enabled: false"),
    );
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toHaveLength(0);

    const r = runCli(ctx, ["enable", "hello"]);
    expect(r.code).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("enabled: true");
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello.plist");
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
    expect(listPlists(ctx)).toContain("com.test.cronfish.trap.plist");

    const r = runCli(ctx, ["disable", "trap"]);
    expect(r.code).toBe(0);
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("enabled: false");
    // The string literal stayed intact.
    expect(after).toContain('"this job is enabled when needed"');
    expect(after).toContain('"enabled: false (in a string)"');
    expect(listPlists(ctx)).not.toContain("com.test.cronfish.trap.plist");
  });

  test("delete --yes removes plist and job file", () => {
    const path = writeJob(ctx, "hello.md", MD_ENABLED);
    runCli(ctx, ["sync"]);
    expect(listPlists(ctx)).toContain("com.test.cronfish.hello.plist");

    const r = runCli(ctx, ["delete", "hello", "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(listPlists(ctx)).not.toContain("com.test.cronfish.hello.plist");
  });

  test("delete without --yes refuses", () => {
    const path = writeJob(ctx, "hello.md", MD_ENABLED);
    const r = runCli(ctx, ["delete", "hello"]);
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
    expect(sync.out).toContain("bootstrap email/triage");
    expect(listPlists(ctx)).toContain("com.test.cronfish.email.triage.plist");

    const list = runCli(ctx, ["list"]);
    expect(list.out).toContain("email/triage");
    // loaded column should report yes (faked launchctl print returns 0).
    const row = list.out.split("\n").find((l) => l.startsWith("email/triage"));
    expect(row).toBeDefined();
    expect(row!.split("\t")).toContain("yes");

    // Idempotent.
    const sync2 = runCli(ctx, ["sync"]);
    expect(sync2.out).toContain("up-to-date email/triage");

    // Disable and re-sync removes the plist.
    const dis = runCli(ctx, ["disable", "email/triage"]);
    expect(dis.code).toBe(0);
    expect(listPlists(ctx)).not.toContain(
      "com.test.cronfish.email.triage.plist",
    );
  });

  test("README.md anywhere under cron/ is ignored", () => {
    mkdirSync(join(ctx.root, "cron", "group"), { recursive: true });
    writeFileSync(join(ctx.root, "cron", "README.md"), "# top");
    writeFileSync(join(ctx.root, "cron", "group", "README.md"), "# group");
    writeFileSync(join(ctx.root, "cron", "group", "real.md"), MD_ENABLED);

    const list = runCli(ctx, ["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("group/real");
    expect(list.out).not.toMatch(/^README\b/m);
    expect(list.out).not.toMatch(/group\/README/);
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
});
