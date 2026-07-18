import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import {
  TAIL_READ_BYTES,
  daemonLabel,
  installDaemon,
  listPerJobLabels,
  renderDaemonPlist,
  tailLines,
  uninstallDaemon,
  type DaemonServiceIo,
  type HeartbeatPeek,
} from "../src/platform/daemon-launchd.ts";

const PREFIX = "com.test.cronfish";

// Stubbed launchctl: a loaded-label set driven by bootstrap/bootout, plus a
// call log so tests can assert ordering (teardown strictly before load).
// Models the real macOS wedge (seen live on Darwin 25.2): bootstrap REGISTERS
// a label but does not spawn it despite RunAtLoad — only kickstart moves it
// to `running`. The heartbeat stub keys off `running`, so installDaemon only
// passes if it kickstarts after bootstrap.
interface FakeLaunchd {
  io: DaemonServiceIo;
  loaded: Set<string>;
  running: Set<string>;
  calls: string[][];
}

function labelFromArg(arg: string): string {
  // "gui/501/label", ".../label.plist", or a bare path.
  const last = arg.split("/").pop()!;
  return last.replace(/\.plist$/, "");
}

function fakeLaunchd(
  dir: string,
  opts: { bootoutFails?: boolean } = {},
): FakeLaunchd {
  const loaded = new Set<string>();
  const running = new Set<string>();
  const calls: string[][] = [];
  const io: DaemonServiceIo = {
    launchAgentsDir: dir,
    guiDomain: "gui/501",
    exec: (cmd) => {
      calls.push(cmd);
      const [, verb, target] = [cmd[0], cmd[1]!, cmd[2] ?? ""];
      const label = labelFromArg(cmd[cmd.length - 1]!);
      if (verb === "print") {
        return loaded.has(label)
          ? { code: 0, out: label, err: "" }
          : { code: 113, out: "", err: "not found" };
      }
      if (verb === "bootout") {
        if (!opts.bootoutFails) {
          loaded.delete(label);
          running.delete(label);
        }
        return { code: 0, out: "", err: "" };
      }
      if (verb === "bootstrap") {
        // Registers only — the RunAtLoad spawn stays pended (the real bug).
        loaded.add(labelFromArg(target === "gui/501" ? cmd[3]! : target));
        return { code: 0, out: "", err: "" };
      }
      if (verb === "kickstart") {
        if (!loaded.has(label)) {
          return { code: 113, out: "", err: "not found" };
        }
        running.add(label);
        return { code: 0, out: "", err: "" };
      }
      return { code: 0, out: "", err: "" };
    },
  };
  return { io, loaded, running, calls };
}

// Heartbeat stub tied to the fake launchctl: only a RUNNING daemon ticks —
// a bootstrapped-but-pended one never produces a heartbeat.
function heartbeatFrom(fake: FakeLaunchd): () => HeartbeatPeek | null {
  return () =>
    fake.running.has(daemonLabel(PREFIX))
      ? { pid: 999, last_tick_at: new Date().toISOString() }
      : null;
}

function seedPerJobPlist(dir: string, fake: FakeLaunchd, suffix: string): void {
  const label = `${PREFIX}.${suffix}`;
  writeFileSync(join(dir, `${label}.plist`), `<plist>${label}</plist>`, "utf-8");
  fake.loaded.add(label);
}

let base: string;
let agents: string;
let root: string;
const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};
const noSleep = async (): Promise<void> => {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cronfish-dinstall-"));
  agents = join(base, "LaunchAgents");
  root = join(base, "consumer");
  mkdirSync(agents, { recursive: true });
  mkdirSync(root, { recursive: true });
  logs.length = 0;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("renderDaemonPlist", () => {
  test("KeepAlive daemon wrapping `cronfish daemon` with the consumer root", () => {
    const r = renderDaemonPlist({ bundlePrefix: PREFIX, consumerRoot: root });
    expect(r.label).toBe(`${PREFIX}.daemon`);
    expect(r.contents).toContain("<key>KeepAlive</key>");
    expect(r.contents).toContain("<key>RunAtLoad</key>");
    expect(r.contents).toContain("<string>daemon</string>");
    expect(r.contents).toContain(`<string>${root}</string>`);
    expect(r.contents).toContain(
      join(root, ".cronfish", "logs", "daemon", "daemon.log"),
    );
  });
});

describe("listPerJobLabels", () => {
  test("excludes the reserved daemon and ui labels", () => {
    const fake = fakeLaunchd(agents);
    seedPerJobPlist(agents, fake, "hello-md");
    seedPerJobPlist(agents, fake, "daemon");
    seedPerJobPlist(agents, fake, "ui");
    writeFileSync(join(agents, "com.other.app.job.plist"), "x", "utf-8");
    expect(listPerJobLabels(PREFIX, fake.io)).toEqual([
      `${PREFIX}.hello-md`,
    ]);
  });
});

describe("installDaemon — hot swap", () => {
  test("retires per-job plists BEFORE loading the daemon, verifies heartbeat", async () => {
    const fake = fakeLaunchd(agents);
    seedPerJobPlist(agents, fake, "hello-md");
    seedPerJobPlist(agents, fake, "email.triage-ts");
    seedPerJobPlist(agents, fake, "ui"); // must survive

    const r = await installDaemon({
      bundlePrefix: PREFIX,
      consumerRoot: root,
      io: fake.io,
      readHeartbeat: heartbeatFrom(fake),
      sleep: noSleep,
      log,
    });

    expect(r.changed).toBe(true);
    expect(r.removedPerJob.sort()).toEqual([
      `${PREFIX}.email.triage-ts`,
      `${PREFIX}.hello-md`,
    ]);
    // Per-job plists gone from disk and unloaded; ui + daemon remain.
    const files = readdirSync(agents).sort();
    expect(files).toEqual([
      `${PREFIX}.daemon.plist`,
      `${PREFIX}.ui.plist`,
    ]);
    expect(fake.loaded.has(`${PREFIX}.hello-md`)).toBe(false);
    expect(fake.loaded.has(`${PREFIX}.daemon`)).toBe(true);
    // Ordering: every bootout of a per-job label precedes the bootstrap.
    const bootstrapIdx = fake.calls.findIndex((c) => c[1] === "bootstrap");
    const lastJobBootout = fake.calls
      .map((c, i) => (c[1] === "bootout" ? i : -1))
      .filter((i) => i >= 0)
      .pop()!;
    expect(bootstrapIdx).toBeGreaterThan(lastJobBootout);
    // Kickstart fires AFTER bootstrap (before the heartbeat wait — the fake
    // only ticks a RUNNING daemon, so a live heartbeat proves the order).
    const kickstartIdx = fake.calls.findIndex((c) => c[1] === "kickstart");
    expect(kickstartIdx).toBeGreaterThan(bootstrapIdx);
    expect(fake.calls[kickstartIdx]).toEqual([
      "launchctl",
      "kickstart",
      `gui/501/${PREFIX}.daemon`,
    ]);
    expect(fake.running.has(`${PREFIX}.daemon`)).toBe(true);
    // Daemon plist content is the render output.
    expect(readFileSync(r.plistPath, "utf-8")).toContain(
      "<key>KeepAlive</key>",
    );
    // All five phases printed.
    for (const phase of ["1/5", "2/5", "3/5", "4/5", "5/5"]) {
      expect(logs.some((l) => l.includes(phase))).toBe(true);
    }
  });

  test("idempotent: re-install with a live daemon reloads nothing", async () => {
    const fake = fakeLaunchd(agents);
    const opts = {
      bundlePrefix: PREFIX,
      consumerRoot: root,
      io: fake.io,
      readHeartbeat: heartbeatFrom(fake),
      sleep: noSleep,
      log,
    };
    await installDaemon(opts);
    const callsBefore = fake.calls.length;
    const r2 = await installDaemon(opts);
    expect(r2.changed).toBe(false);
    expect(r2.removedPerJob).toEqual([]);
    const callsAfter = fake.calls.slice(callsBefore);
    expect(callsAfter.some((c) => c[1] === "bootstrap")).toBe(false);
    expect(callsAfter.some((c) => c[1] === "bootout")).toBe(false);
    // Plain kickstart (no -k) still fires — a no-op on the healthy running
    // daemon, but it rescues a loaded-but-pended one without killing anything.
    const kick = callsAfter.find((c) => c[1] === "kickstart");
    expect(kick).toEqual([
      "launchctl",
      "kickstart",
      `gui/501/${PREFIX}.daemon`,
    ]);
  });

  test("refuses to load the daemon when a per-job plist survives teardown", async () => {
    const fake = fakeLaunchd(agents, { bootoutFails: true });
    seedPerJobPlist(agents, fake, "stuck-md");
    await expect(
      installDaemon({
        bundlePrefix: PREFIX,
        consumerRoot: root,
        io: fake.io,
        readHeartbeat: heartbeatFrom(fake),
        sleep: noSleep,
        log,
      }),
    ).rejects.toThrow(/still present after teardown/);
    // Daemon plist never written — both modes at once is impossible.
    expect(existsSync(join(agents, `${PREFIX}.daemon.plist`))).toBe(false);
  });

  test("throws when no heartbeat appears within the wait window, inlining the daemon log tail", async () => {
    const fake = fakeLaunchd(agents);
    // Seed a daemon log so the timeout error carries its last lines.
    const logDir = join(root, ".cronfish", "logs", "daemon");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "daemon.log"),
      "line one\nerror: db locked\n",
      "utf-8",
    );
    await expect(
      installDaemon({
        bundlePrefix: PREFIX,
        consumerRoot: root,
        io: fake.io,
        readHeartbeat: () => null, // daemon never ticks
        heartbeatWaitMs: 50,
        sleep: noSleep,
        log,
      }),
    ).rejects.toThrow(
      /no live heartbeat[\s\S]*error: db locked[\s\S]*per-job plists were already retired[\s\S]*cronfish sync/,
    );
  });
});

describe("tailLines", () => {
  test("reads only the final TAIL_READ_BYTES of a large log", () => {
    const logDir = join(root, ".cronfish", "logs", "daemon");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "daemon.log");
    // ~1MB of filler followed by the lines that matter.
    const filler = `${"x".repeat(99)}\n`.repeat(10_000);
    writeFileSync(logPath, `${filler}penultimate line\nfinal line\n`, "utf-8");
    const tail = tailLines(logPath, 2);
    expect(tail).toBe("penultimate line\nfinal line");
    // A tail longer than the byte window is bounded by TAIL_READ_BYTES.
    const big = tailLines(logPath, 1_000_000);
    expect(Buffer.byteLength(big, "utf-8")).toBeLessThanOrEqual(
      TAIL_READ_BYTES,
    );
  });

  test("missing or empty file → empty string", () => {
    expect(tailLines(join(root, "nope.log"), 5)).toBe("");
    const p = join(root, "empty.log");
    writeFileSync(p, "", "utf-8");
    expect(tailLines(p, 5)).toBe("");
  });
});

describe("uninstallDaemon", () => {
  test("removes the plist, boots out, and warns about per-job plists", async () => {
    const fake = fakeLaunchd(agents);
    await installDaemon({
      bundlePrefix: PREFIX,
      consumerRoot: root,
      io: fake.io,
      readHeartbeat: heartbeatFrom(fake),
      sleep: noSleep,
      log,
    });
    logs.length = 0;
    const r = uninstallDaemon({ bundlePrefix: PREFIX, io: fake.io, log });
    expect(r.existed).toBe(true);
    expect(existsSync(join(agents, `${PREFIX}.daemon.plist`))).toBe(false);
    expect(fake.loaded.has(`${PREFIX}.daemon`)).toBe(false);
    expect(
      logs.some((l) => l.includes("NOT restored automatically")),
    ).toBe(true);
  });

  test("not installed → existed=false, still warns", () => {
    const fake = fakeLaunchd(agents);
    const r = uninstallDaemon({ bundlePrefix: PREFIX, io: fake.io, log });
    expect(r.existed).toBe(false);
    expect(logs.some((l) => l.includes("not installed"))).toBe(true);
  });
});
