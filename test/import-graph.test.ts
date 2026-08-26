// The published entry points must be importable ANYWHERE, not just on the
// machine cronfish runs on.
//
// cronfish only RUNS on macOS, but its modules get imported elsewhere: a
// consumer's test suite pulling in `cronfish/authoring` to create jobs, a
// typecheck, a docs build, Linux CI. A top-level `dlopen()` turns "import this
// module" into a hard error on any of those — `src/oneTime.ts` did exactly
// that with `dlopen("libc." + suffix)` for flock(2), and it took down 6 test
// files in the agents repo's Linux CI the first time anything imported the
// authoring seam. On Linux the file is `libc.so.6`; bare `libc.so` is a
// linker-only symlink that ships with a -dev package.
//
// The fix is to load native libraries lazily, at first use. This test is the
// never-again: it walks the real transitive import graph of each published
// entry point and fails if any module in it calls dlopen at module scope.
// Grepping one file would not have caught this — the offending call was three
// hops away from the entry point anyone actually imports.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

// Every subpath in package.json#exports that a consumer can import.
const ENTRY_POINTS = ["authoring.ts", "schedule.ts", "jobs.ts"];

/** Transitively resolve relative imports from `entry`, returning absolute paths. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    for (const m of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return [...seen];
}

/**
 * Is there a `dlopen(` at module scope (column 0-ish, not inside a function)?
 * A call indented by at least two spaces is inside something — which is what
 * lazy loading looks like.
 */
function topLevelDlopen(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => /\bdlopen\s*\(/.test(l) && !/^\s\s+/.test(l) && !l.trim().startsWith("//"))
    .map((l) => l.trim());
}

describe("published entry points stay portable", () => {
  for (const entry of ENTRY_POINTS) {
    test(`${entry}: no module-scope dlopen anywhere in its import graph`, () => {
      const offenders: string[] = [];
      for (const file of importGraph(entry)) {
        for (const line of topLevelDlopen(readFileSync(file, "utf-8"))) {
          offenders.push(`${file.slice(SRC.length)}: ${line}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  test("the graph walker actually resolves imports (guard against a silent no-op)", () => {
    const graph = importGraph("authoring.ts");
    expect(graph.length).toBeGreaterThan(3);
    expect(graph.some((f) => f.endsWith("schedule.ts"))).toBe(true);
    expect(graph.some((f) => f.endsWith("oneTime.ts"))).toBe(true);
  });
});
