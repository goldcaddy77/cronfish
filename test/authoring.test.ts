import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthoringError,
  commitNewJob,
  parseFutureRunAt,
  planNewJob,
  previewFires,
  relativeFromNow,
  slugifyJobName,
  toLocalOffsetIso,
} from "../src/authoring.ts";
import { loadJob } from "../src/jobs.ts";

let cronDir: string;

beforeEach(() => {
  cronDir = join(mkdtempSync(join(tmpdir(), "cronfish-authoring-")), "cron");
  mkdirSync(cronDir, { recursive: true });
});
afterEach(() => {
  rmSync(join(cronDir, ".."), { recursive: true, force: true });
});

const NOW = new Date("2026-08-26T09:00:00-04:00");

describe("slugifyJobName", () => {
  test("lowercases and dashes", () => {
    expect(slugifyJobName("Runaway Spend Watchdog")).toBe("runaway-spend-watchdog");
    expect(slugifyJobName("daily_brief!!")).toBe("daily-brief");
  });

  test("strips a trailing job extension so `cronfish new foo.md` works", () => {
    expect(slugifyJobName("nightly-backup.sh")).toBe("nightly-backup");
  });

  test("refuses paths and traversal", () => {
    expect(() => slugifyJobName("../escape")).toThrow(AuthoringError);
    expect(() => slugifyJobName("nested/job")).toThrow(AuthoringError);
  });

  test("refuses names that slugify to nothing", () => {
    expect(() => slugifyJobName("!!!")).toThrow(/slugifies to nothing/);
    expect(() => slugifyJobName("")).toThrow(/required/);
  });
});

describe("parseFutureRunAt", () => {
  test("accepts ISO in the future", () => {
    const d = parseFutureRunAt("2026-08-29T09:07:00-04:00", NOW);
    expect(d.toISOString()).toBe("2026-08-29T13:07:00.000Z");
  });

  test("accepts relative offsets", () => {
    expect(parseFutureRunAt("+90m", NOW).toISOString()).toBe("2026-08-26T14:30:00.000Z");
    expect(parseFutureRunAt("+2d", NOW).toISOString()).toBe("2026-08-28T13:00:00.000Z");
  });

  test("rejects the past — a one-time job in the past never fires", () => {
    expect(() => parseFutureRunAt("2020-01-01T00:00:00Z", NOW)).toThrow(/in the past/);
  });

  test("rejects unparseable timestamps", () => {
    expect(() => parseFutureRunAt("next tuesday", NOW)).toThrow(/not a parseable timestamp/);
    expect(() => parseFutureRunAt("", NOW)).toThrow(/required/);
  });
});

describe("previewFires", () => {
  test("cron fires resolve in local time, N of them, strictly after `from`", () => {
    const fires = previewFires("0 9 * * *", 3, NOW);
    expect(fires).toHaveLength(3);
    expect(fires.every((f) => f.getTime() > NOW.getTime())).toBe(true);
    expect(fires.map((f) => toLocalOffsetIso(f).slice(11, 16))).toEqual([
      "09:00",
      "09:00",
      "09:00",
    ]);
  });

  test("the CAD-1577 shape now previews instead of throwing", () => {
    const fires = previewFires("every day at 07:20", 2, NOW);
    expect(fires).toHaveLength(2);
    expect(toLocalOffsetIso(fires[0]).slice(11, 16)).toBe("07:20");
  });

  test("intervals step by the interval", () => {
    const fires = previewFires("every 5 minutes", 2, NOW);
    expect(fires[0].getTime() - NOW.getTime()).toBe(300_000);
    expect(fires[1].getTime() - NOW.getTime()).toBe(600_000);
  });

  test("manual has no fire times", () => {
    expect(previewFires("manual", 3, NOW)).toEqual([]);
  });

  test("an unparseable schedule throws rather than previewing nothing", () => {
    expect(() => previewFires("every morning at 8", 3, NOW)).toThrow(/unrecognized human form/);
  });
});

describe("relativeFromNow", () => {
  test("formats forward and backward", () => {
    expect(relativeFromNow(new Date(NOW.getTime() + 3600_000), NOW)).toBe("in 1h");
    expect(relativeFromNow(new Date(NOW.getTime() - 90_000), NOW)).toBe("1m ago");
  });
});

describe("planNewJob — the explicit either/or", () => {
  test("refuses both --schedule and --at", () => {
    expect(() =>
      planNewJob(cronDir, { name: "x", kind: "md", schedule: "0 9 * * *", runAt: "+1h", body: "b", now: NOW }),
    ).toThrow(/pick one/);
  });

  test("refuses neither", () => {
    expect(() => planNewJob(cronDir, { name: "x", kind: "md", body: "b", now: NOW })).toThrow(
      /a job needs a time/,
    );
  });

  test("a one-time job lands in cron/one-time/ with run_at, never a pinned cron expression", () => {
    const plan = planNewJob(cronDir, {
      name: "flip back",
      kind: "md",
      runAt: "2026-08-29T09:07:00-04:00",
      body: "Flip it back.",
      now: NOW,
    });
    expect(plan.oneTime).toBe(true);
    expect(plan.slug).toBe("one-time/flip-back-md");
    expect(plan.relPath).toBe("one-time/flip-back.md");
    // Rendered as a local-offset ISO, so assert the instant rather than the
    // literal string — the test process runs in UTC, a user's shell does not.
    const runAt = plan.content.match(/run_at: "([^"]+)"/)![1];
    expect(new Date(runAt).getTime()).toBe(new Date("2026-08-29T09:07:00-04:00").getTime());
    expect(runAt).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(plan.content).not.toContain("schedule:");
    expect(plan.fires).toHaveLength(1);
  });

  test("a recurring job lands in cron/ with schedule and no run_at", () => {
    const plan = planNewJob(cronDir, {
      name: "spend watchdog",
      kind: "md",
      schedule: "every day at 07:20",
      body: "Check spend.",
      now: NOW,
    });
    expect(plan.oneTime).toBe(false);
    expect(plan.slug).toBe("spend-watchdog-md");
    expect(plan.content).toContain('schedule: "every day at 07:20"');
    expect(plan.content).not.toContain("run_at");
    expect(plan.fires).toHaveLength(3);
  });

  test("--grace is refused on a recurring job", () => {
    expect(() =>
      planNewJob(cronDir, { name: "x", kind: "md", schedule: "0 9 * * *", body: "b", graceSeconds: 60, now: NOW }),
    ).toThrow(/only applies to one-time/);
  });

  test("--model is refused on a script job", () => {
    expect(() =>
      planNewJob(cronDir, { name: "x", kind: "sh", schedule: "0 9 * * *", body: "b", model: "opus", now: NOW }),
    ).toThrow(/only applies to \.md/);
  });

  test("a one-time job refuses a placeholder body — it would burn the one fire", () => {
    expect(() => planNewJob(cronDir, { name: "x", kind: "md", runAt: "+1h", now: NOW })).toThrow(
      /needs a --body/,
    );
  });

  test("a recurring job with no body gets a placeholder and is NOT armed", () => {
    const plan = planNewJob(cronDir, { name: "x", kind: "md", schedule: "0 9 * * *", now: NOW });
    expect(plan.enabled).toBe(false);
    expect(plan.content).toContain("enabled: false");
    expect(plan.content).toContain("TODO");
  });

  test("an unparseable schedule throws before anything is written", () => {
    expect(() =>
      planNewJob(cronDir, { name: "x", kind: "md", schedule: "every day at 07:20 sharp", body: "b", now: NOW }),
    ).toThrow(/unrecognized human form/);
    expect(existsSync(join(cronDir, "x.md"))).toBe(false);
  });

  test("collides across kinds, and --force only overwrites the same file", () => {
    writeFileSync(join(cronDir, "dupe.sh"), "#!/usr/bin/env bash\n");
    expect(() =>
      planNewJob(cronDir, { name: "dupe", kind: "md", schedule: "0 9 * * *", body: "b", now: NOW }),
    ).toThrow(/already exists/);
    expect(() =>
      planNewJob(cronDir, { name: "dupe", kind: "md", schedule: "0 9 * * *", body: "b", force: true, now: NOW }),
    ).toThrow(/already exists/);
    const plan = planNewJob(cronDir, {
      name: "dupe",
      kind: "sh",
      schedule: "0 9 * * *",
      body: "true",
      force: true,
      now: NOW,
    });
    expect(plan.overwrite).toBe(true);
  });

  test("rejects an unknown kind", () => {
    expect(() =>
      // deliberately bypassing the type to exercise the runtime guard
      planNewJob(cronDir, { name: "x", kind: "py" as never, schedule: "0 9 * * *", body: "b", now: NOW }),
    ).toThrow(/kind must be one of/);
  });
});

describe("commitNewJob — every kind round-trips through the real loader", () => {
  for (const kind of ["md", "ts", "sh"] as const) {
    test(`recurring ${kind}`, () => {
      const plan = planNewJob(cronDir, {
        name: `recurring ${kind}`,
        kind,
        schedule: "every day at 07:20",
        body: kind === "md" ? "Do the thing." : 'echo "hi"',
        description: 'has "quotes" and a # hash',
        timeout: 600,
        retries: 2,
        concurrency: "skip",
        now: NOW,
      });
      commitNewJob(cronDir, plan);
      const meta = loadJob(plan.path, plan.slug, cronDir);
      expect(meta.enabled).toBe(true);
      expect(meta.schedule).toBe("every day at 07:20");
      expect(meta.timeout).toBe(600);
      expect(meta.retries).toBe(2);
      expect(meta.concurrency).toBe("skip");
      expect(meta.description).toContain("hash");
      expect(meta.oneTime).toBeFalsy();
    });

    test(`one-time ${kind}`, () => {
      const plan = planNewJob(cronDir, {
        name: `once ${kind}`,
        kind,
        runAt: "2026-08-29T09:07:00-04:00",
        graceSeconds: 86400,
        body: kind === "md" ? "Do it once." : 'echo "once"',
        now: NOW,
      });
      commitNewJob(cronDir, plan);
      const meta = loadJob(plan.path, plan.slug, cronDir);
      expect(meta.oneTime).toBe(true);
      expect(meta.schedule).toBeUndefined();
      expect(meta.graceSeconds).toBe(86400);
      expect(meta.runAtMs).toBe(new Date("2026-08-29T09:07:00-04:00").getTime());
    });
  }

  test("a ts body may not smuggle in its own config block", () => {
    expect(() =>
      planNewJob(cronDir, {
        name: "smuggler",
        kind: "ts",
        schedule: "0 9 * * *",
        body: "export const config = { schedule: 'manual' };\nexport default async function run() {}",
        now: NOW,
      }),
    ).toThrow(/must not define/);
  });

  test("a ts body with its own export default is kept verbatim", () => {
    const plan = planNewJob(cronDir, {
      name: "own default",
      kind: "ts",
      schedule: "0 9 * * *",
      body: "export default async function run() { console.log(1); }",
      now: NOW,
    });
    commitNewJob(cronDir, plan);
    const src = readFileSync(plan.path, "utf-8");
    expect(src.match(/export default/g)).toHaveLength(1);
  });

  test("a sh job is written executable with a shebang we own", () => {
    const plan = planNewJob(cronDir, {
      name: "shellish",
      kind: "sh",
      schedule: "0 9 * * *",
      body: "#!/bin/zsh\necho hi",
      now: NOW,
    });
    commitNewJob(cronDir, plan);
    const src = readFileSync(plan.path, "utf-8");
    expect(src.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(src).not.toContain("#!/bin/zsh");
    expect(src).toContain("set -euo pipefail");
  });
});
