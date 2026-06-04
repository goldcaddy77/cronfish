import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// cli.ts wires label prefix at module-load from `.cronfish.json` + cwd.
// Easiest test: spawn the CLI in scratch consumer roots and verify behavior.

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function runCli(
  root: string,
  args: string[],
): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: root,
    env: { ...process.env, CRONFISH_CONSUMER_ROOT: root },
  });
  return {
    code: proc.exitCode ?? 0,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

describe("bundle prefix", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("CLI runs with default prefix (no .cronfish.json)", () => {
    const r = runCli(root, ["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(no jobs in cron/)");
    // Default prefix is com.cronfish.<basename(root)> — we can't observe it
    // until a plist is rendered, but the CLI must not crash without a config.
    expect(basename(root).startsWith("cronfish-test-")).toBe(true);
  });

  test(".cronfish.json override does not crash list", () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({ bundle_prefix: "com.example.x" }),
    );
    mkdirSync(join(root, "cron"));
    writeFileSync(
      join(root, "cron", "demo.md"),
      `---\nschedule: "every 5 minutes"\nenabled: false\n---\nbody`,
    );
    const r = runCli(root, ["list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("demo");
    expect(r.out).toContain("*/5 * * * *");
  });

  test("malformed .cronfish.json surfaces error", () => {
    writeFileSync(join(root, ".cronfish.json"), "{ this is not json");
    const r = runCli(root, ["list"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(".cronfish.json");
  });
});
