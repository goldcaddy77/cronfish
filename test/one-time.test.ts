import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverJobs, loadJob } from "../src/jobs.ts";
import {
  parseRunAt,
  resolveOneTime,
  tryFlockExclusive,
  releaseFlock,
  writeSentinel,
  sentinelFilename,
  clearSentinels,
  reapStaleSentinels,
  errorsDir,
  setTsExecutedAt,
} from "../src/oneTime.ts";

function makeRoot(): { root: string; cron: string; oneTime: string } {
  const root = mkdtempSync(join(tmpdir(), "cronfish-one-time-"));
  const cron = join(root, "cron");
  const oneTime = join(cron, "one-time");
  mkdirSync(oneTime, { recursive: true });
  return { root, cron, oneTime };
}

describe("parseRunAt", () => {
  test("absolute ISO", () => {
    const t = parseRunAt("2026-06-25T15:00:00Z", 0);
    expect(t).toBe(Date.UTC(2026, 5, 25, 15, 0, 0));
  });

  test("relative +30s against mtime", () => {
    const mtime = 1_000_000_000_000;
    expect(parseRunAt("+30s", mtime)).toBe(mtime + 30_000);
    expect(parseRunAt("+5m", mtime)).toBe(mtime + 300_000);
    expect(parseRunAt("+1h", mtime)).toBe(mtime + 3_600_000);
    expect(parseRunAt("+1d", mtime)).toBe(mtime + 86_400_000);
  });

  test("garbage rejected", () => {
    expect(() => parseRunAt("not-a-date", 0)).toThrow(/run_at/);
    expect(() => parseRunAt("+30x", 0)).toThrow(/run_at/);
  });
});

describe("resolveOneTime", () => {
  const now = 10_000_000;
  test("executed_at short-circuits", () => {
    const r = resolveOneTime(now - 10_000, 300, now, "2026-01-01T00:00:00Z");
    expect(r.kind).toBe("executed");
  });

  test("future → scheduled", () => {
    const future = now + 86_400_000; // +1d
    const r = resolveOneTime(future, 300, now, undefined);
    expect(r.kind).toBe("scheduled");
  });

  test("within grace → fire-now", () => {
    const r = resolveOneTime(now - 100_000, 300, now, undefined); // 100s ago
    expect(r.kind).toBe("fire-now");
  });

  test("past grace → past-grace", () => {
    const r = resolveOneTime(now - 600_000, 300, now, undefined); // 10m ago, grace 5m
    expect(r.kind).toBe("past-grace");
    if (r.kind === "past-grace") expect(r.reason).toMatch(/grace=300/);
  });
});

describe("discovery — one-time", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("flags files under cron/one-time/ as oneTime + parses run_at", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    writeFileSync(
      join(h.oneTime, "verify.md"),
      `---\nrun_at: ${future}\n---\nhello\n`,
    );
    const { jobs, errors } = discoverJobs(h.cron);
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].oneTime).toBe(true);
    expect(jobs[0].runAtMs).toBe(Date.parse(future));
    expect(jobs[0].graceSeconds).toBe(300);
  });

  test("recurring file outside one-time does not get oneTime flag", () => {
    writeFileSync(
      join(h.cron, "hello.md"),
      `---\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const { jobs } = discoverJobs(h.cron);
    expect(jobs[0].oneTime).toBeUndefined();
  });

  test("one-time without run_at is rejected", () => {
    writeFileSync(join(h.oneTime, "bad.md"), `---\n---\nbody\n`);
    const { errors } = discoverJobs(h.cron);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/run_at/);
  });

  test("one-time + schedule is rejected", () => {
    writeFileSync(
      join(h.oneTime, "bad.md"),
      `---\nrun_at: "+10s"\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const { errors } = discoverJobs(h.cron);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/schedule/);
  });

  test("run_at outside one-time is rejected", () => {
    writeFileSync(
      join(h.cron, "stray.md"),
      `---\nrun_at: "+10s"\n---\nbody\n`,
    );
    const { errors } = discoverJobs(h.cron);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/only valid inside cron\/one-time/);
  });

  test("relative run_at uses file mtime as anchor", () => {
    const p = join(h.oneTime, "rel.md");
    writeFileSync(p, `---\nrun_at: "+30s"\n---\nbody\n`);
    const past = new Date("2026-06-01T00:00:00Z");
    utimesSync(p, past, past);
    const job = loadJob(p, undefined, h.cron);
    expect(job.runAtMs).toBe(past.getTime() + 30_000);
  });

  test(".errors folder is skipped during discovery", () => {
    mkdirSync(errorsDir(h.cron), { recursive: true });
    writeFileSync(join(errorsDir(h.cron), "1.txt"), "junk");
    writeFileSync(
      join(h.oneTime, "ok.md"),
      `---\nrun_at: "+1h"\n---\nbody\n`,
    );
    const { jobs, errors } = discoverJobs(h.cron);
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
  });

  test("TS one-time job parses run_at + grace_seconds + executed_at", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    writeFileSync(
      join(h.oneTime, "verify.ts"),
      `export const config = {\n  run_at: "${future}",\n  grace_seconds: 60,\n  executed_at: "2026-01-01T00:00:00Z",\n};\nexport default async function run() {}\n`,
    );
    const { jobs, errors } = discoverJobs(h.cron);
    expect(errors).toEqual([]);
    expect(jobs[0].oneTime).toBe(true);
    expect(jobs[0].runAtMs).toBe(Date.parse(future));
    expect(jobs[0].graceSeconds).toBe(60);
    expect(jobs[0].executedAt).toBe("2026-01-01T00:00:00Z");
  });
});

describe("writeSentinel", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("writes sentinel under cron/.errors/", () => {
    writeSentinel(h.cron, "verify-health-abc", "past grace");
    const files = readdirSync(errorsDir(h.cron));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/verify-health-abc/);
    const body = readFileSync(join(errorsDir(h.cron), files[0]), "utf-8");
    expect(body).toMatch(/past grace/);
  });

  test("dedups: same (slug, reason) overwrites instead of piling up", () => {
    for (let i = 0; i < 50; i++) {
      writeSentinel(h.cron, "discover.ts", "discovery error: boom", "sync");
    }
    expect(readdirSync(errorsDir(h.cron))).toHaveLength(1);
  });

  test("distinct reasons for one slug coexist", () => {
    writeSentinel(h.cron, "discover.ts", "reason A", "sync");
    writeSentinel(h.cron, "discover.ts", "reason B", "sync");
    expect(readdirSync(errorsDir(h.cron))).toHaveLength(2);
  });
});

describe("sentinel lifecycle (clear / reap)", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("clearSentinels(slug) only removes that slug; clearSentinels() removes all", () => {
    writeSentinel(h.cron, "alpha", "x", "sync");
    writeSentinel(h.cron, "beta", "y", "run");
    writeFileSync(join(errorsDir(h.cron), "consumer-owned.txt"), "foreign");

    expect(clearSentinels(h.cron, "alpha")).toBe(1);
    expect(readdirSync(errorsDir(h.cron))).toHaveLength(2);

    expect(clearSentinels(h.cron)).toBe(2); // beta + foreign
    expect(readdirSync(errorsDir(h.cron))).toHaveLength(0);
  });

  test("reapStaleSentinels drops sync-class not rewritten, keeps run-class + foreign", () => {
    const stale = sentinelFilename("gone", "discovery error: x", "sync");
    writeSentinel(h.cron, "gone", "discovery error: x", "sync"); // not in keep → reaped
    writeSentinel(h.cron, "still", "discovery error: y", "sync"); // in keep → kept
    writeSentinel(h.cron, "past", "runtime past grace", "run"); // run-class → kept
    writeFileSync(join(errorsDir(h.cron), "consumer.txt"), "foreign"); // foreign → kept

    const keep = new Set([sentinelFilename("still", "discovery error: y", "sync")]);
    const reaped = reapStaleSentinels(h.cron, keep);

    expect(reaped).toBe(1);
    const left = readdirSync(errorsDir(h.cron)).sort();
    expect(left).not.toContain(stale);
    expect(left).toHaveLength(3); // still + past + foreign
  });
});

describe("flock guard", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("second acquire fails while first holds", () => {
    const p = join(h.oneTime, "lockme.md");
    writeFileSync(p, `---\nrun_at: "+1h"\n---\nbody\n`);
    const first = tryFlockExclusive(p);
    expect(first).not.toBeNull();
    const second = tryFlockExclusive(p);
    expect(second).toBeNull();
    if (first) releaseFlock(first);
    const third = tryFlockExclusive(p);
    expect(third).not.toBeNull();
    if (third) releaseFlock(third);
  });
});

describe("setTsExecutedAt", () => {
  test("inserts when missing", () => {
    const src = `export const config = {\n  run_at: "+10s",\n};\nexport default async function run() {}\n`;
    const next = setTsExecutedAt(src, "2026-06-23T12:00:00Z");
    expect(next).toContain(`executed_at: "2026-06-23T12:00:00Z"`);
  });

  test("replaces existing", () => {
    const src = `export const config = {\n  executed_at: "old",\n  run_at: "+10s",\n};\n`;
    const next = setTsExecutedAt(src, "2026-06-23T12:00:00Z");
    expect(next).toContain(`executed_at: "2026-06-23T12:00:00Z"`);
    expect(next).not.toContain(`"old"`);
  });
});
