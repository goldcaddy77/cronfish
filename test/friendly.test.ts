import { describe, expect, test } from "bun:test";
import { parseFriendly } from "../src/parsers/friendly.ts";

describe("parseFriendly", () => {
  test("singulars", () => {
    expect(parseFriendly("every second")).toEqual({
      kind: "seconds",
      value: 1,
    });
    expect(parseFriendly("every minute")).toEqual({
      kind: "seconds",
      value: 60,
    });
    expect(parseFriendly("every hour")).toEqual({
      kind: "seconds",
      value: 3600,
    });
  });

  test("every N minutes", () => {
    expect(parseFriendly("every 5 minutes")).toEqual({
      kind: "seconds",
      value: 300,
    });
    expect(parseFriendly("every 1 minute")).toEqual({
      kind: "seconds",
      value: 60,
    });
  });

  test("every N hours", () => {
    expect(parseFriendly("every 2 hours")).toEqual({
      kind: "seconds",
      value: 7200,
    });
  });

  test("every N days", () => {
    expect(parseFriendly("every 3 days")).toEqual({
      kind: "seconds",
      value: 259200,
    });
  });

  test("every N seconds", () => {
    expect(parseFriendly("every 30 seconds")).toEqual({
      kind: "seconds",
      value: 30,
    });
  });

  test("non-every input returns null", () => {
    expect(parseFriendly("5m")).toBeNull();
    expect(parseFriendly("0 9 * * *")).toBeNull();
  });

  test("unknown unit returns null", () => {
    expect(parseFriendly("every 5 fortnights")).toBeNull();
  });

  test("case insensitive", () => {
    expect(parseFriendly("Every 5 Minutes")).toEqual({
      kind: "seconds",
      value: 300,
    });
  });

  // The calendar half. "every day at 07:20" reads perfectly and used to throw
  // — two jobs shipped with it, were marked BAD, and were skipped in silence
  // (CAD-1577). A time of day is a cron expression, not an interval.
  describe("calendar forms", () => {
    test("every day at <time>, in every time shape", () => {
      expect(parseFriendly("every day at 9")).toEqual({ kind: "cron", expr: "0 9 * * *" });
      expect(parseFriendly("every day at 07:20")).toEqual({ kind: "cron", expr: "20 7 * * *" });
      expect(parseFriendly("every day at 3pm")).toEqual({ kind: "cron", expr: "0 15 * * *" });
      expect(parseFriendly("every day at 12am")).toEqual({ kind: "cron", expr: "0 0 * * *" });
      expect(parseFriendly("every day at 12pm")).toEqual({ kind: "cron", expr: "0 12 * * *" });
      expect(parseFriendly("every day at 8:05 AM")).toEqual({ kind: "cron", expr: "5 8 * * *" });
    });

    test("every <dayname> at <time>", () => {
      expect(parseFriendly("every monday at 8:30")).toEqual({ kind: "cron", expr: "30 8 * * 1" });
      expect(parseFriendly("every sun at 6")).toEqual({ kind: "cron", expr: "0 6 * * 0" });
      expect(parseFriendly("every saturday at 11pm")).toEqual({ kind: "cron", expr: "0 23 * * 6" });
    });

    test("every hour at :MM", () => {
      expect(parseFriendly("every hour at :15")).toEqual({ kind: "cron", expr: "15 * * * *" });
      expect(parseFriendly("every hour at 15")).toEqual({ kind: "cron", expr: "15 * * * *" });
    });

    test("out-of-range times are refused, not clamped", () => {
      expect(parseFriendly("every day at 25:00")).toBeNull();
      expect(parseFriendly("every day at 9:75")).toBeNull();
      expect(parseFriendly("every day at 13pm")).toBeNull();
      expect(parseFriendly("every hour at :60")).toBeNull();
    });

    test("ambiguous periods are refused rather than guessed at", () => {
      expect(parseFriendly("every day")).toBeNull();
      expect(parseFriendly("every morning at 8")).toBeNull();
      expect(parseFriendly("every weekday at 9")).toBeNull();
      expect(parseFriendly("every fortnight at 9")).toBeNull();
    });
  });
});
