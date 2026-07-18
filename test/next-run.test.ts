import { describe, expect, test } from "bun:test";
import { computeNextRun, scheduleKind } from "../src/next-run.ts";

const NOW = new Date("2026-07-17T12:00:00.000Z");

function minutesAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 60_000);
}

describe("computeNextRun — intervals", () => {
  test("never-run job is due immediately", () => {
    expect(computeNextRun("5m", null, NOW)).toEqual(NOW);
    expect(computeNextRun("every hour", null, NOW)).toEqual(NOW);
  });

  test("fresh last run lands one interval out", () => {
    const last = minutesAgo(2);
    expect(computeNextRun("5m", last, NOW)).toEqual(
      new Date(last.getTime() + 5 * 60_000),
    );
  });

  test("stale last run is clamped to now, never the past", () => {
    expect(computeNextRun("5m", minutesAgo(40), NOW)).toEqual(NOW);
  });

  // The doc's canonical schedule-change examples (docs/v2-daemon.md).
  test("hourly → every-5-min with a 40-min-old last run fires immediately", () => {
    expect(computeNextRun("5m", minutesAgo(40), NOW)).toEqual(NOW);
  });

  test("every-5-min → hourly with a 2-min-old last run lands 58 min out", () => {
    expect(computeNextRun("1h", minutesAgo(2), NOW)).toEqual(
      new Date(NOW.getTime() + 58 * 60_000),
    );
  });
});

describe("computeNextRun — cron expressions", () => {
  test("next occurrence strictly after now (ignores last run)", () => {
    // 12:00:00Z is exactly on the boundary — strictly-after means 13:00.
    const next = computeNextRun("0 * * * *", minutesAgo(120), NOW, {
      timezone: "UTC",
    });
    expect(next).toEqual(new Date("2026-07-17T13:00:00.000Z"));
  });

  test("interval → cron crossover recomputes from now", () => {
    // A stale interval-era last run does not make a cron schedule overdue.
    const next = computeNextRun("0 9 * * *", minutesAgo(600), NOW, {
      timezone: "UTC",
    });
    expect(next).toEqual(new Date("2026-07-18T09:00:00.000Z"));
  });

  test("DST spring-forward: daily noon in New York is 23 UTC-hours apart", () => {
    // 2026-03-08 America/New_York jumps 02:00 → 03:00. Noon-to-noon across
    // the gap is 23 hours of wall-clock UTC; naive +24h math gets this wrong.
    const before = new Date("2026-03-07T17:00:00.000Z"); // Mar 7 12:00 EST
    const next = computeNextRun("0 12 * * *", null, before, {
      timezone: "America/New_York",
    });
    expect(next).toEqual(new Date("2026-03-08T16:00:00.000Z")); // Mar 8 12:00 EDT
    expect(next!.getTime() - before.getTime()).toBe(23 * 3600_000);
  });
});

describe("computeNextRun — manual + errors", () => {
  test("manual never auto-fires", () => {
    expect(computeNextRun("manual", null, NOW)).toBeNull();
    expect(computeNextRun("manual", minutesAgo(999), NOW)).toBeNull();
  });

  test("unparseable schedule throws (same contract as dispatchSchedule)", () => {
    expect(() => computeNextRun("every blue moon", null, NOW)).toThrow();
    expect(() => computeNextRun(undefined, null, NOW)).toThrow();
  });
});

describe("scheduleKind", () => {
  test("classifies interval / cron / manual", () => {
    expect(scheduleKind("5m")).toBe("interval");
    expect(scheduleKind("every 30 seconds")).toBe("interval");
    expect(scheduleKind(60)).toBe("interval");
    expect(scheduleKind("0 9 * * *")).toBe("cron");
    expect(scheduleKind("manual")).toBe("manual");
  });
});
