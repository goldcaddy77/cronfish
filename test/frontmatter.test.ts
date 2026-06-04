import { describe, expect, test } from "bun:test";
import {
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

  test("migrates every: to schedule:", () => {
    const raw = `---
every: 600
model: sonnet
---

body`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.schedule).toBe(600);
    expect(frontmatter.every).toBeUndefined();
  });

  test("schedule: wins over every:", () => {
    const raw = `---
schedule: "5m"
every: 60
---
`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.schedule).toBe("5m");
  });

  test("returns raw body when no frontmatter", () => {
    const raw = "just body, no frontmatter";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe(raw);
  });
});

describe("parseTsJobConfig", () => {
  test("parses every and aliases to schedule", () => {
    const src = `export const config = {
      every: 600,
      enabled: true,
      timeout: 540,
    };`;
    const cfg = parseTsJobConfig(src);
    expect(cfg.schedule).toBe(600);
    expect(cfg.enabled).toBe(true);
    expect(cfg.timeout).toBe(540);
  });

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
});

describe("setFrontmatterKey", () => {
  test("updates existing key", () => {
    const raw = `---
schedule: "5m"
enabled: true
---
body`;
    const next = setFrontmatterKey(raw, "enabled", false);
    expect(next).toContain("enabled: false");
    expect(next).not.toContain("enabled: true");
  });

  test("appends missing key", () => {
    const raw = `---
schedule: "5m"
---
body`;
    const next = setFrontmatterKey(raw, "enabled", false);
    expect(next).toContain("enabled: false");
  });
});
