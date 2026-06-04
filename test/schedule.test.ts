import { describe, expect, test } from "bun:test";
import { dispatchSchedule } from "../src/schedule.ts";

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
