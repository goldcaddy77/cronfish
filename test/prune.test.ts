import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLogs } from "../src/prune.ts";

let root: string;

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed clock for deterministic age math

function writeLog(slug: string, name: string, ageDays: number): string {
  const dir = join(root, ".cronfish", "logs", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "log body\n", "utf-8");
  const tMs = NOW - ageDays * DAY;
  utimesSync(path, new Date(tMs), new Date(tMs));
  return path;
}

function logsIn(slug: string): string[] {
  const dir = join(root, ".cronfish", "logs", slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".log"))
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cronfish-prune-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pruneLogs", () => {
  test("max_age_days deletes only logs older than the cutoff", () => {
    writeLog("foo-md", "1.log", 40);
    writeLog("foo-md", "2.log", 20);
    writeLog("foo-md", "3.log", 1);

    const report = pruneLogs({
      consumerRoot: root,
      global: { maxAgeDays: 30 },
      nowMs: NOW,
    });

    expect(report.totalDeleted).toBe(1);
    expect(logsIn("foo-md")).toEqual(["2.log", "3.log"]);
  });

  test("max_runs keeps the N newest by mtime", () => {
    writeLog("foo-md", "1.log", 5);
    writeLog("foo-md", "2.log", 3);
    writeLog("foo-md", "3.log", 1);
    writeLog("foo-md", "4.log", 10);

    const report = pruneLogs({
      consumerRoot: root,
      global: { maxRuns: 2 },
      nowMs: NOW,
    });

    expect(report.totalDeleted).toBe(2);
    // Newest two by mtime are 3.log (1d) and 2.log (3d).
    expect(logsIn("foo-md")).toEqual(["2.log", "3.log"]);
  });

  test("dry-run reports victims but deletes nothing", () => {
    writeLog("foo-md", "1.log", 40);
    writeLog("foo-md", "2.log", 1);

    const report = pruneLogs({
      consumerRoot: root,
      global: { maxAgeDays: 30 },
      dryRun: true,
      nowMs: NOW,
    });

    expect(report.totalDeleted).toBe(1);
    expect(logsIn("foo-md")).toEqual(["1.log", "2.log"]);
  });

  test("per-slug override replaces the global default for that slug", () => {
    writeLog("noisy-md", "1.log", 10);
    writeLog("noisy-md", "2.log", 5);
    writeLog("noisy-md", "3.log", 1);
    writeLog("quiet-md", "1.log", 10);

    const report = pruneLogs({
      consumerRoot: root,
      global: { maxAgeDays: 30 }, // would keep everything
      perSlug: { "noisy-md": { maxRuns: 1 } },
      nowMs: NOW,
    });

    expect(logsIn("noisy-md")).toEqual(["3.log"]);
    expect(logsIn("quiet-md")).toEqual(["1.log"]);
    expect(report.totalDeleted).toBe(2);
  });

  test("onlySlug scopes pruning to a single slug", () => {
    writeLog("a-md", "1.log", 40);
    writeLog("b-md", "1.log", 40);

    pruneLogs({
      consumerRoot: root,
      global: { maxAgeDays: 30 },
      onlySlug: "a-md",
      nowMs: NOW,
    });

    expect(logsIn("a-md")).toEqual([]);
    expect(logsIn("b-md")).toEqual(["1.log"]);
  });

  test("nested slug dirs are pruned and keyed with forward slashes", () => {
    writeLog("email/triage-ts", "1.log", 40);
    writeLog("email/triage-ts", "2.log", 1);

    const report = pruneLogs({
      consumerRoot: root,
      global: {},
      perSlug: { "email/triage-ts": { maxAgeDays: 30 } },
      nowMs: NOW,
    });

    expect(report.slugs[0]?.slug).toBe("email/triage-ts");
    expect(logsIn("email/triage-ts")).toEqual(["2.log"]);
  });

  test("daemon logs at the logs root (ui.log) are never touched", () => {
    const logsDir = join(root, ".cronfish", "logs");
    mkdirSync(logsDir, { recursive: true });
    const uiLog = join(logsDir, "ui.log");
    writeFileSync(uiLog, "ui\n", "utf-8");
    const old = NOW - 100 * DAY;
    utimesSync(uiLog, new Date(old), new Date(old));

    pruneLogs({ consumerRoot: root, global: { maxAgeDays: 1 }, nowMs: NOW });

    expect(existsSync(uiLog)).toBe(true);
  });

  test("a slug with no limits set is skipped entirely", () => {
    writeLog("foo-md", "1.log", 999);
    const report = pruneLogs({ consumerRoot: root, global: {}, nowMs: NOW });
    expect(report.totalDeleted).toBe(0);
    expect(logsIn("foo-md")).toEqual(["1.log"]);
  });

  test("missing logs dir yields an empty report", () => {
    const report = pruneLogs({
      consumerRoot: root,
      global: { maxAgeDays: 1 },
      nowMs: NOW,
    });
    expect(report.totalDeleted).toBe(0);
    expect(report.slugs).toEqual([]);
  });
});
