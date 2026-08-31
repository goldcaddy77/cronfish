import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadClaudeConfig } from "../src/config.ts";

describe("loadClaudeConfig", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-claude-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (obj: unknown) =>
    writeFileSync(join(root, ".cronfish.json"), JSON.stringify(obj));

  test("reads a string entrypoint_command", () => {
    write({ claude: { entrypoint_command: "print-prompt.sh" } });
    expect(loadClaudeConfig(root)).toEqual({
      entrypoint_command: "print-prompt.sh",
    });
  });

  test("null when the file is absent", () => {
    expect(loadClaudeConfig(root)).toBeNull();
  });

  test("null when there is no claude block", () => {
    write({ store: { type: "sqlite" } });
    expect(loadClaudeConfig(root)).toBeNull();
  });

  test("null when entrypoint_command is empty or whitespace", () => {
    write({ claude: { entrypoint_command: "   " } });
    expect(loadClaudeConfig(root)).toBeNull();
  });

  test("null when entrypoint_command is not a string", () => {
    write({ claude: { entrypoint_command: 42 } });
    expect(loadClaudeConfig(root)).toBeNull();
  });

  test("null on unparseable JSON (never throws)", () => {
    writeFileSync(join(root, ".cronfish.json"), "{ not json");
    expect(loadClaudeConfig(root)).toBeNull();
  });
});
