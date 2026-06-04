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

  test("human form: every N minutes → cron", () => {
    expect(dispatchSchedule("every 5 minutes")).toEqual({
      kind: "cron",
      expr: "*/5 * * * *",
    });
  });

  test("human form: every hour → cron", () => {
    expect(dispatchSchedule("every hour")).toEqual({
      kind: "cron",
      expr: "0 * * * *",
    });
  });

  test("human form: every second → seconds(1)", () => {
    expect(dispatchSchedule("every second")).toEqual({
      kind: "seconds",
      value: 1,
    });
  });

  test("human form: every N seconds → seconds(N)", () => {
    expect(dispatchSchedule("every 30 seconds")).toEqual({
      kind: "seconds",
      value: 30,
    });
  });

  test("garbage throws", () => {
    expect(() => dispatchSchedule("not a schedule")).toThrow();
    expect(() => dispatchSchedule("every blue moon")).toThrow();
    expect(() => dispatchSchedule(undefined)).toThrow();
    expect(() => dispatchSchedule(0)).toThrow();
  });
});
