import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/platform/launchd.ts";
import { loadJob } from "../src/jobs.ts";

function makeRoot(): { root: string; cron: string; oneTime: string } {
  const root = mkdtempSync(join(tmpdir(), "cronfish-render-"));
  const cron = join(root, "cron");
  const oneTime = join(cron, "one-time");
  mkdirSync(oneTime, { recursive: true });
  return { root, cron, oneTime };
}

describe("launchd render — .env preservation", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("injects .env keys into EnvironmentVariables block", () => {
    writeFileSync(
      join(h.root, ".env"),
      `FOO=bar\nBAZ="quoted value"\n# comment\nQUX=with#hash\n`,
    );
    writeFileSync(
      join(h.cron, "hello.md"),
      `---\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const job = loadJob(join(h.cron, "hello.md"), "hello-md", h.cron);
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).toContain("<key>FOO</key>");
    expect(r.contents).toContain("<string>bar</string>");
    expect(r.contents).toContain("<key>BAZ</key>");
    expect(r.contents).toContain("<string>quoted value</string>");
    expect(r.contents).toContain("<key>HOME</key>");
    expect(r.contents).toContain("<key>CRONFISH_CONSUMER_ROOT</key>");
    expect(r.contents).toContain("<key>PATH</key>");
  });

  test("missing .env still renders with required keys", () => {
    writeFileSync(
      join(h.cron, "hello.md"),
      `---\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const job = loadJob(join(h.cron, "hello.md"), "hello-md", h.cron);
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).toContain("<key>HOME</key>");
    expect(r.contents).toContain("<key>CRONFISH_CONSUMER_ROOT</key>");
    expect(r.contents).toContain("<key>PATH</key>");
  });

  test("xml-escapes special chars in env values", () => {
    writeFileSync(
      join(h.root, ".env"),
      `URL=https://example.com/?a=1&b=2\n`,
    );
    writeFileSync(
      join(h.cron, "hello.md"),
      `---\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const job = loadJob(join(h.cron, "hello.md"), "hello-md", h.cron);
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).toContain("https://example.com/?a=1&amp;b=2");
  });

  test("required keys win over .env collisions", () => {
    writeFileSync(join(h.root, ".env"), `HOME=/totally-wrong\n`);
    writeFileSync(
      join(h.cron, "hello.md"),
      `---\nschedule: "every 5 minutes"\n---\nbody\n`,
    );
    const job = loadJob(join(h.cron, "hello.md"), "hello-md", h.cron);
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).not.toContain("/totally-wrong");
  });
});

describe("launchd render — one-time", () => {
  let h: ReturnType<typeof makeRoot>;
  beforeEach(() => {
    h = makeRoot();
  });
  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  test("fire-now omits StartCalendarInterval and sets RunAtLoad true", () => {
    // run_at in the past but within grace
    const past = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(
      join(h.oneTime, "now.md"),
      `---\nrun_at: ${past}\n---\nbody\n`,
    );
    const job = loadJob(join(h.oneTime, "now.md"), "one-time/now-md", h.cron);
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).not.toContain("StartCalendarInterval");
    expect(r.contents).toContain("<key>RunAtLoad</key>\n    <true/>");
  });

  test("future emits StartCalendarInterval with all 4 calendar fields", () => {
    const future = new Date(Date.now() + 86_400_000);
    writeFileSync(
      join(h.oneTime, "later.md"),
      `---\nrun_at: ${future.toISOString()}\n---\nbody\n`,
    );
    const job = loadJob(
      join(h.oneTime, "later.md"),
      "one-time/later-md",
      h.cron,
    );
    const r = render(job, {
      bundlePrefix: "com.test.app",
      consumerRoot: h.root,
    });
    expect(r.contents).toContain("StartCalendarInterval");
    expect(r.contents).toContain("<key>Minute</key>");
    expect(r.contents).toContain("<key>Hour</key>");
    expect(r.contents).toContain("<key>Day</key>");
    expect(r.contents).toContain("<key>Month</key>");
    expect(r.contents).toContain("<key>RunAtLoad</key>\n    <false/>");
  });
});
