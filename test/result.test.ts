import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLastResult, SENTINEL_PREFIX } from "../src/result.ts";

function tmpLog(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cronfish-result-"));
  const path = join(dir, "test.log");
  writeFileSync(path, content);
  return path;
}

describe("parseLastResult", () => {
  test("returns null when no sentinel present", async () => {
    const p = tmpLog("hello\nworld\n");
    const r = await parseLastResult(p);
    expect(r.result).toBeNull();
  });

  test("parses a simple sentinel", async () => {
    const payload = { summary: "did stuff", ok: true, metrics: { n: 3 } };
    const p = tmpLog(`noise\n${SENTINEL_PREFIX}${JSON.stringify(payload)}\n`);
    const r = await parseLastResult(p);
    expect(r.result?.summary).toBe("did stuff");
    expect(r.result?.ok).toBe(true);
    expect(r.result?.metrics).toEqual({ n: 3 });
  });

  test("uses the LAST sentinel if multiple", async () => {
    const a = { summary: "first" };
    const b = { summary: "second" };
    const p = tmpLog(
      `${SENTINEL_PREFIX}${JSON.stringify(a)}\n${SENTINEL_PREFIX}${JSON.stringify(b)}\n`,
    );
    const r = await parseLastResult(p);
    expect(r.result?.summary).toBe("second");
  });

  test("invalid JSON → null, no throw", async () => {
    const p = tmpLog(`${SENTINEL_PREFIX}not json\n`);
    const r = await parseLastResult(p);
    expect(r.result).toBeNull();
  });

  test("schema violation (missing summary) → null", async () => {
    const p = tmpLog(`${SENTINEL_PREFIX}${JSON.stringify({ ok: true })}\n`);
    const r = await parseLastResult(p);
    expect(r.result).toBeNull();
  });

  test("summary too long → null", async () => {
    const p = tmpLog(
      `${SENTINEL_PREFIX}${JSON.stringify({ summary: "x".repeat(200) })}\n`,
    );
    const r = await parseLastResult(p);
    expect(r.result).toBeNull();
  });

  test("metrics with non-primitive → null", async () => {
    const p = tmpLog(
      `${SENTINEL_PREFIX}${JSON.stringify({
        summary: "x",
        metrics: { n: { nested: 1 } },
      })}\n`,
    );
    const r = await parseLastResult(p);
    expect(r.result).toBeNull();
  });

  test("100MB of preamble then a sentinel still parses (uses 64KB tail)", async () => {
    const big = "x".repeat(1024 * 1024); // 1MB
    const payload = { summary: "after big" };
    const content =
      Array(100).fill(big).join("\n") +
      `\n${SENTINEL_PREFIX}${JSON.stringify(payload)}\n`;
    const p = tmpLog(content);
    const r = await parseLastResult(p);
    expect(r.result?.summary).toBe("after big");
    expect(r.truncated).toBe(true);
  });
});
