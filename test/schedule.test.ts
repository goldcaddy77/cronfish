import { describe, expect, test } from "bun:test";
import { annualCronWarning, dispatchSchedule } from "../src/schedule.ts";

describe("dispatchSchedule", () => {
  test("5-field cron passes through", () => {
    expect(dispatchSchedule("0 9 * * *")).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
    });
    expect(dispatchSchedule("30 14 1 * *")).toEqual({
      kind: "cron",
      expr: "30 14 1 * *",
    });
  });

  test("bare integer = seconds", () => {
    expect(dispatchSchedule(60)).toEqual({ kind: "seconds", value: 60 });
    expect(dispatchSchedule("60")).toEqual({ kind: "seconds", value: 60 });
  });

  test("compact unit suffix", () => {
    expect(dispatchSchedule("60s")).toEqual({ kind: "seconds", value: 60 });
    expect(dispatchSchedule("5m")).toEqual({ kind: "seconds", value: 300 });
    expect(dispatchSchedule("2h")).toEqual({ kind: "seconds", value: 7200 });
    expect(dispatchSchedule("1d")).toEqual({ kind: "seconds", value: 86400 });
  });

  test("human form → seconds", () => {
    expect(dispatchSchedule("every 5 minutes")).toEqual({
      kind: "seconds",
      value: 300,
    });
    expect(dispatchSchedule("every hour")).toEqual({
      kind: "seconds",
      value: 3600,
    });
    expect(dispatchSchedule("every second")).toEqual({
      kind: "seconds",
      value: 1,
    });
    expect(dispatchSchedule("every 30 seconds")).toEqual({
      kind: "seconds",
      value: 30,
    });
  });

  test("manual is a first-class kind", () => {
    expect(dispatchSchedule("manual")).toEqual({ kind: "manual" });
    expect(dispatchSchedule("MANUAL")).toEqual({ kind: "manual" });
  });

  test("cron range validation rejects out-of-range fields", () => {
    expect(() => dispatchSchedule("99 99 99 99 99")).toThrow(/out of range/);
    expect(() => dispatchSchedule("60 0 * * *")).toThrow(/minute/);
    expect(() => dispatchSchedule("0 24 * * *")).toThrow(/hour/);
    expect(() => dispatchSchedule("0 0 32 * *")).toThrow(/day-of-month/);
    expect(() => dispatchSchedule("0 0 * 13 *")).toThrow(/month/);
    expect(() => dispatchSchedule("0 0 * * 8")).toThrow(/day-of-week/);
  });

  test("cron rejects negatives", () => {
    expect(() => dispatchSchedule("-1 0 * * *")).toThrow();
  });

  test("garbage throws", () => {
    expect(() => dispatchSchedule("not a schedule")).toThrow();
    expect(() => dispatchSchedule("every blue moon")).toThrow();
    expect(() => dispatchSchedule(undefined)).toThrow();
    expect(() => dispatchSchedule(0)).toThrow();
    expect(() => dispatchSchedule(-5)).toThrow();
    expect(() => dispatchSchedule("")).toThrow();
  });

  test("error messages name the bad input", () => {
    try {
      dispatchSchedule("60 0 * * *");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("minute");
      expect((e as Error).message).toContain("60");
    }
  });
});

// CAD-1585: a one-shot job wearing a recurring costume. `7 9 29 8 *` parses,
// installs, and passes every guard — it is not invalid, it is just not what
// was meant, and it fires again every August. A create-command cannot prevent
// it on a hand-written file, so the check looks at the OUTCOME instead.
describe("annualCronWarning", () => {
  test("warns when both day-of-month and month are pinned", () => {
    expect(annualCronWarning("7 9 29 8 *")).toContain("ONCE A YEAR");
    expect(annualCronWarning("7 9 29 8 *")).toContain("--at");
    expect(annualCronWarning("0 0 1 1 *")).toContain("ONCE A YEAR");
  });

  test("stays quiet for monthly, weekly, daily and interval schedules", () => {
    expect(annualCronWarning("0 9 29 * *")).toBeNull(); // 29th of every month
    expect(annualCronWarning("0 9 * * 1")).toBeNull(); // every Monday
    expect(annualCronWarning("0 9 * * *")).toBeNull(); // daily
    expect(annualCronWarning("every 5 minutes")).toBeNull();
    expect(annualCronWarning("every day at 07:20")).toBeNull();
    expect(annualCronWarning("manual")).toBeNull();
  });

  test("stays quiet on an unparseable schedule — that is a louder problem, reported elsewhere", () => {
    expect(annualCronWarning("every morning at 8")).toBeNull();
    expect(annualCronWarning(undefined)).toBeNull();
  });
});
