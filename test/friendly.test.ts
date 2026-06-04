import { describe, expect, test } from "bun:test";
import { parseFriendly } from "../src/parsers/friendly.ts";

describe("parseFriendly", () => {
  test("singulars", () => {
    expect(parseFriendly("every second")).toEqual({
      kind: "seconds",
      value: 1,
    });
    expect(parseFriendly("every minute")).toEqual({
      kind: "cron",
      expr: "* * * * *",
    });
    expect(parseFriendly("every hour")).toEqual({
      kind: "cron",
      expr: "0 * * * *",
    });
  });

  test("every N minutes", () => {
    expect(parseFriendly("every 5 minutes")).toEqual({
      kind: "cron",
      expr: "*/5 * * * *",
    });
    expect(parseFriendly("every 1 minute")).toEqual({
      kind: "cron",
      expr: "*/1 * * * *",
    });
  });

  test("every N hours", () => {
    expect(parseFriendly("every 2 hours")).toEqual({
      kind: "cron",
      expr: "0 */2 * * *",
    });
  });

  test("every N days", () => {
    expect(parseFriendly("every 3 days")).toEqual({
      kind: "cron",
      expr: "0 0 */3 * *",
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
      kind: "cron",
      expr: "*/5 * * * *",
    });
  });
});
