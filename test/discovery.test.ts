import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverJobs,
  findJobFile,
  loadJob,
  slugFromPath,
} from "../src/jobs.ts";

const MD = `---
schedule: "every 5 minutes"
enabled: true
---
body
`;

const TS = `export const config = { schedule: 60, enabled: true };
export default async function run() {}
`;

describe("tree discovery", () => {
  let root: string;
  let cron: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-discover-"));
    cron = join(root, "cron");
    mkdirSync(cron, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("recurses into subdirectories and slugs are relative paths", () => {
    writeFileSync(join(cron, "top.md"), MD);
    mkdirSync(join(cron, "email"), { recursive: true });
    writeFileSync(join(cron, "email", "triage.ts"), TS);
    mkdirSync(join(cron, "linkedin", "trend"), { recursive: true });
    writeFileSync(join(cron, "linkedin", "trend", "scan.md"), MD);

    const { jobs, errors } = discoverJobs(cron);
    expect(errors).toEqual([]);
    expect(jobs.map((j) => j.slug).sort()).toEqual([
      "email/triage-ts",
      "linkedin/trend/scan-md",
      "top-md",
    ]);
  });

  test("ignores README.md at any depth", () => {
    writeFileSync(join(cron, "README.md"), "# top docs");
    writeFileSync(join(cron, "real.md"), MD);
    mkdirSync(join(cron, "email"), { recursive: true });
    writeFileSync(join(cron, "email", "README.md"), "# email docs");
    writeFileSync(join(cron, "email", "triage.ts"), TS);

    const { jobs, errors } = discoverJobs(cron);
    expect(errors).toEqual([]);
    expect(jobs.map((j) => j.slug).sort()).toEqual([
      "email/triage-ts",
      "real-md",
    ]);
  });

  test("non .md/.ts/.sh files are skipped", () => {
    writeFileSync(join(cron, "notes.txt"), "ignored");
    writeFileSync(join(cron, "data.json"), "{}");
    writeFileSync(join(cron, "real.md"), MD);

    const { jobs } = discoverJobs(cron);
    expect(jobs.map((j) => j.slug)).toEqual(["real-md"]);
  });

  test("foo.md and foo.sh coexist as separate slugs (no collision)", () => {
    writeFileSync(join(cron, "foo.md"), MD);
    writeFileSync(
      join(cron, "foo.sh"),
      `#!/bin/bash
# ---
# schedule: "every 5 minutes"
# ---
echo ok
`,
    );
    const { jobs, errors } = discoverJobs(cron);
    expect(errors).toEqual([]);
    expect(jobs.map((j) => j.slug).sort()).toEqual(["foo-md", "foo-sh"]);
  });

  test(".sh without frontmatter reports a discovery error", () => {
    writeFileSync(join(cron, "naked.sh"), `echo hello\n`);
    const { jobs, errors } = discoverJobs(cron);
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('# ---');
  });

  test("discovers .sh jobs and parses comment frontmatter", () => {
    writeFileSync(
      join(cron, "ping.sh"),
      `#!/bin/bash
# ---
# schedule: "every 5 minutes"
# enabled: true
# timeout: 30
# ---
echo hello
`,
    );
    const { jobs, errors } = discoverJobs(cron);
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.slug).toBe("ping-sh");
    expect(jobs[0]!.kind).toBe("sh");
    expect(jobs[0]!.schedule).toBe("every 5 minutes");
    expect(jobs[0]!.timeout).toBe(30);
    expect(jobs[0]!.enabled).toBe(true);
  });

  test("findJobFile resolves nested slugs", () => {
    mkdirSync(join(cron, "email"), { recursive: true });
    const path = join(cron, "email", "triage.ts");
    writeFileSync(path, TS);
    expect(findJobFile(cron, "email/triage-ts")).toBe(path);
    expect(findJobFile(cron, "email/missing-ts")).toBeNull();
    expect(findJobFile(cron, "email/triage")).toBeNull(); // no suffix → invalid
  });

  test("slugFromPath rewrites .ext to -ext and uses forward slashes", () => {
    const p = join(cron, "email", "triage.ts");
    expect(slugFromPath(cron, p)).toBe("email/triage-ts");
    expect(slugFromPath(cron, join(cron, "foo.sh"))).toBe("foo-sh");
    expect(slugFromPath(cron, join(cron, "foo.md"))).toBe("foo-md");
  });
});

describe("security frontmatter fields on .md jobs", () => {
  let root: string;
  let cron: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-sec-"));
    cron = join(root, "cron");
    mkdirSync(cron, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("env / allowed_tools / max_cost land on the parsed meta", () => {
    const p = join(cron, "fenced.md");
    writeFileSync(
      p,
      `---\nschedule: "5m"\nenv: [LINEAR_TOKEN, DATABASE_URL]\nallowed_tools: [Read, "Bash(git status)"]\nmax_cost: 0.50\n---\nbody\n`,
    );
    const job = loadJob(p, "fenced-md", cron);
    expect(job.env).toEqual(["LINEAR_TOKEN", "DATABASE_URL"]);
    expect(job.allowed_tools).toEqual(["Read", "Bash(git status)"]);
    expect(job.max_cost).toBe(0.5);
  });

  test("integer max_cost is accepted", () => {
    const p = join(cron, "cap.md");
    writeFileSync(p, `---\nschedule: "5m"\nmax_cost: 3\n---\nbody\n`);
    expect(loadJob(p, "cap-md", cron).max_cost).toBe(3);
  });

  test("non-numeric max_cost is a validation error", () => {
    const p = join(cron, "bad.md");
    writeFileSync(p, `---\nschedule: "5m"\nmax_cost: lots\n---\nbody\n`);
    expect(() => loadJob(p, "bad-md", cron)).toThrow(/max_cost/);
  });

  test("the fields are absent by default", () => {
    const p = join(cron, "plain.md");
    writeFileSync(p, `---\nschedule: "5m"\n---\nbody\n`);
    const job = loadJob(p, "plain-md", cron);
    expect(job.env).toBeUndefined();
    expect(job.allowed_tools).toBeUndefined();
    expect(job.max_cost).toBeUndefined();
  });
});
