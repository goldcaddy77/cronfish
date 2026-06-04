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
});
