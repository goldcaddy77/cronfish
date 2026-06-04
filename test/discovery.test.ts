import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverJobs, findJobFile, slugFromPath } from "../src/jobs.ts";

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
      "email/triage",
      "linkedin/trend/scan",
      "top",
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
    expect(jobs.map((j) => j.slug).sort()).toEqual(["email/triage", "real"]);
  });

  test("non .md/.ts files are skipped", () => {
    writeFileSync(join(cron, "notes.txt"), "ignored");
    writeFileSync(join(cron, "data.json"), "{}");
    writeFileSync(join(cron, "real.md"), MD);

    const { jobs } = discoverJobs(cron);
    expect(jobs.map((j) => j.slug)).toEqual(["real"]);
  });

  test("findJobFile resolves nested slugs", () => {
    mkdirSync(join(cron, "email"), { recursive: true });
    const path = join(cron, "email", "triage.ts");
    writeFileSync(path, TS);
    expect(findJobFile(cron, "email/triage")).toBe(path);
    expect(findJobFile(cron, "email/missing")).toBeNull();
  });

  test("slugFromPath strips extension and uses forward slashes", () => {
    const p = join(cron, "email", "triage.ts");
    expect(slugFromPath(cron, p)).toBe("email/triage");
  });
});
