import { describe, expect, test } from "bun:test";
import {
  FrontmatterError,
  parseFrontmatter,
  parseTsJobConfig,
  setFrontmatterKey,
} from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("parses all supported keys", () => {
    const raw = `---
schedule: "0 9 * * *"
model: haiku
enabled: true
timeout: 300
retries: 2
concurrency: skip
---

body here`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.schedule).toBe("0 9 * * *");
    expect(frontmatter.model).toBe("haiku");
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.timeout).toBe(300);
    expect(frontmatter.retries).toBe(2);
    expect(frontmatter.concurrency).toBe("skip");
    expect(body.trim()).toBe("body here");
  });

  test("rejects `every:` key explicitly", () => {
    const raw = `---\nevery: 600\n---\nbody`;
    expect(() => parseFrontmatter(raw)).toThrow(FrontmatterError);
    expect(() => parseFrontmatter(raw)).toThrow(/rename to "schedule"/);
  });

  test("inline comments stripped from unquoted values only", () => {
    const { frontmatter } = parseFrontmatter(
      `---\nschedule: 60 # every minute\nmodel: "haiku # not a comment"\n---\n`,
    );
    expect(frontmatter.schedule).toBe(60);
    expect(frontmatter.model).toBe("haiku # not a comment");
  });

  test("returns raw body when no frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("just body");
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe("just body");
  });

  test("missing colon throws with line number", () => {
    expect(() => parseFrontmatter(`---\nno colon here\n---\n`)).toThrow(/line/);
  });
});

describe("parseTsJobConfig", () => {
  test("parses schedule string", () => {
    const src = `export const config = {
      schedule: "every 5 minutes",
      enabled: false,
      retries: 3,
      concurrency: "queue",
    };`;
    const cfg = parseTsJobConfig(src);
    expect(cfg.schedule).toBe("every 5 minutes");
    expect(cfg.enabled).toBe(false);
    expect(cfg.retries).toBe(3);
    expect(cfg.concurrency).toBe("queue");
  });

  test("rejects `every:` key", () => {
    const src = `export const config = { every: 600 };`;
    expect(() => parseTsJobConfig(src)).toThrow(/rename to "schedule"/);
  });

  test("handles nested objects without breaking on first inner brace", () => {
    const src = `export const config = {
      env: { FOO: "bar", BAZ: "qux" },
      schedule: "5m",
      enabled: true,
    };`;
    const cfg = parseTsJobConfig(src);
    expect(cfg.schedule).toBe("5m");
    expect(cfg.enabled).toBe(true);
  });

  test("rejects bad enabled value", () => {
    const src = `export const config = { enabled: "yes" };`;
    expect(() => parseTsJobConfig(src)).toThrow();
  });

  test("rejects bad concurrency value", () => {
    const src = `export const config = { concurrency: "all" };`;
    expect(() => parseTsJobConfig(src)).toThrow();
  });

  test("strips trailing TS type assertions (as const, as Foo)", () => {
    const src = `export const config = {
      schedule: "5m",
      concurrency: "skip" as const,
      model: "haiku" as ModelAlias,
    };`;
    const cfg = parseTsJobConfig(src);
    expect(cfg.concurrency).toBe("skip");
    expect(cfg.model).toBe("haiku");
  });
});

describe("setFrontmatterKey", () => {
  test("updates existing key", () => {
    const raw = `---\nschedule: "5m"\nenabled: true\n---\nbody`;
    const next = setFrontmatterKey(raw, "enabled", false);
    expect(next).toContain("enabled: false");
    expect(next).not.toContain("enabled: true");
  });

  test("appends missing key", () => {
    const raw = `---\nschedule: "5m"\n---\nbody`;
    const next = setFrontmatterKey(raw, "enabled", false);
    expect(next).toContain("enabled: false");
  });
});
