// The dashboard reuses one store per consumer instead of opening one per
// request. SQLite: repeated calls keep working. Postgres (opt-in via
// CRONFISH_TEST_PG_URL): repeated and concurrent requests ride the same pool,
// so polling the dashboard does not open new connections.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus } from "../src/ui/server.ts";
import { resolvePgUrl } from "./support/store-harness.ts";

interface BunSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}
function newBunSql(url: string): BunSqlLike {
  const SQL = (Bun as unknown as { SQL: new (url: string) => BunSqlLike }).SQL;
  return new SQL(url);
}

describe("dashboard store reuse [sqlite]", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cronfish-ui-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("repeated and concurrent requests all succeed", async () => {
    const first = await daemonStatus(root);
    expect(first.live).toBe(false);
    const many = await Promise.all(
      Array.from({ length: 5 }, () => daemonStatus(root)),
    );
    for (const r of many) expect(r.heartbeat).toBeNull();
  });
});

const PG_URL = await resolvePgUrl();

if (!PG_URL) {
  describe.skip("dashboard store reuse [no postgres]", () => {
    test("skipped", () => {});
  });
} else {
  const url = PG_URL;
  describe("dashboard store reuse [postgres]", () => {
    let root: string;
    let schema: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "cronfish-ui-pg-"));
      schema = `cronfish_test_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    });
    afterEach(async () => {
      rmSync(root, { recursive: true, force: true });
      const sql = newBunSql(url);
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await sql.end();
      }
    });

    test("polling requests reuse the same connections", async () => {
      const tagged = `${url}${url.includes("?") ? "&" : "?"}application_name=${schema}`;
      writeFileSync(
        join(root, ".cronfish.json"),
        JSON.stringify({ store: { type: "postgres", url: tagged, schema } }),
      );
      const probe = newBunSql(url);
      const backends = async () =>
        (
          await probe.unsafe(
            "SELECT pid FROM pg_stat_activity WHERE application_name = $1 ORDER BY pid",
            [schema],
          )
        ).map((r) => Number(r.pid));
      try {
        await Promise.all(
          Array.from({ length: 5 }, () => daemonStatus(root)),
        );
        const afterBurst = await backends();
        // The store's pool stays open for the next poll, within its cap.
        expect(afterBurst.length).toBeGreaterThan(0);
        expect(afterBurst.length).toBeLessThanOrEqual(2);
        for (let i = 0; i < 5; i++) await daemonStatus(root);
        expect(await backends()).toEqual(afterBurst);
      } finally {
        await probe.end();
      }
    }, 15_000);
  });
}
