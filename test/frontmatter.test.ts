import { describe, expect, test } from "bun:test";
import {
  FrontmatterError,
  parseFrontmatter,
  parseShellFrontmatter,
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

describe("inline arrays (env / allowed_tools)", () => {
  test("parses a YAML inline array into lists", () => {
    const { lists, frontmatter } = parseFrontmatter(
      `---\nschedule: "5m"\nenv: [LINEAR_TOKEN, DATABASE_URL]\n---\nbody`,
    );
    expect(frontmatter.schedule).toBe("5m");
    expect(lists.env).toEqual(["LINEAR_TOKEN", "DATABASE_URL"]);
  });

  test("keeps commas inside quotes and parens, strips quotes", () => {
    const { lists } = parseFrontmatter(
      `---\nallowed_tools: [Read, "Bash(git commit, git push)", mcp__linear__*]\n---\n`,
    );
    expect(lists.allowed_tools).toEqual([
      "Read",
      "Bash(git commit, git push)",
      "mcp__linear__*",
    ]);
  });

  test("empty array is declared-but-empty (distinct from absent)", () => {
    const { lists } = parseFrontmatter(`---\nenv: []\n---\n`);
    expect(lists.env).toEqual([]);
  });

  test("ignores a trailing comment after the closing bracket", () => {
    const { lists } = parseFrontmatter(
      `---\nenv: [A, B] # just two\n---\n`,
    );
    expect(lists.env).toEqual(["A", "B"]);
  });

  test("shell frontmatter surfaces inline arrays", () => {
    const { lists } = parseShellFrontmatter(
      `#!/bin/bash\n# ---\n# schedule: 5m\n# env: [FOO, BAR]\n# ---\necho hi`,
    );
    expect(lists.env).toEqual(["FOO", "BAR"]);
  });

  test("TS config parses env array", () => {
    const cfg = parseTsJobConfig(
      `export const config = {\n  schedule: "5m",\n  env: ["LINEAR_TOKEN", "DATABASE_URL"],\n};`,
    );
    expect(cfg.env).toEqual(["LINEAR_TOKEN", "DATABASE_URL"]);
  });

  test("TS config without env leaves it undefined", () => {
    const cfg = parseTsJobConfig(
      `export const config = { schedule: "5m" };`,
    );
    expect(cfg.env).toBeUndefined();
  });
});

describe("nested on_failure", () => {
  test("parses on_failure block in YAML frontmatter", () => {
    const raw = `---
schedule: "every 5 minutes"
on_failure:
  notify: slack
  channel: "#cron-alerts"
---
body`;
    const { frontmatter, nested } = parseFrontmatter(raw);
    expect(frontmatter.schedule).toBe("every 5 minutes");
    expect(nested.on_failure).toEqual({
      notify: "slack",
      channel: "#cron-alerts",
    });
  });

  test("parses on_failure block in shell comment frontmatter", () => {
    const raw = `#!/bin/bash
# ---
# schedule: every 5 minutes
# on_failure:
#   notify: slack
# ---
echo hi`;
    const { frontmatter, nested } = parseShellFrontmatter(raw);
    expect(frontmatter.schedule).toBe("every 5 minutes");
    expect(nested.on_failure).toEqual({ notify: "slack" });
  });

  test("parses on_failure inline object in TS config", () => {
    const src = `export const config = {
      schedule: "every 5 minutes",
      on_failure: { notify: "slack", channel: "#cron-alerts" },
    };`;
    const cfg = parseTsJobConfig(src);
    expect(cfg.on_failure).toEqual({
      notify: "slack",
      channel: "#cron-alerts",
    });
  });

  test("rejects indented line outside a nested block", () => {
    const raw = `---\nschedule: "5m"\n  stray: yes\n---\n`;
    expect(() => parseFrontmatter(raw)).toThrow(/indented/);
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
