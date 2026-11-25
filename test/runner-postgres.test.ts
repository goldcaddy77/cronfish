// End-to-end: a job run against a Postgres store holds exactly one database
// connection. Spawns the real runner on a consumer whose `.cronfish.json`
// points at a test Postgres, has the job itself count the runner's backends
// mid-run, then checks the ledger row landed and nothing was left open.
// Gated on a reachable test Postgres, like test/postgres-store.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER = new URL("../src/runner.ts", import.meta.url).pathname;

interface BunSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}
function newBunSql(url: string): BunSqlLike {
  const SQL = (Bun as unknown as { SQL: new (url: string) => BunSqlLike }).SQL;
  return new SQL(url);
}

async function reachablePgUrl(): Promise<string | null> {
  const explicit = process.env.CRONFISH_TEST_PG_URL;
  const candidates = explicit
    ? [explicit]
    : [
        "postgres://localhost:5432/postgres",
        "postgres://localhost:5432/agent",
      ];
  for (const url of candidates) {
    try {
      const sql = newBunSql(url);
      await sql.unsafe("SELECT 1");
      await sql.end();
      return url;
    } catch {
      /* next */
    }
  }
  return null;
}

const PG_URL = await reachablePgUrl();

if (!PG_URL) {
  describe.skip("runner on a postgres store [no postgres]", () => {
    test("skipped", () => {});
  });
} else {
  const url = PG_URL;
  describe("runner on a postgres store", () => {
    let root: string;
    let schema: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "cronfish-runner-pg-"));
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

    test("a run holds one connection and closes it when the run ends", async () => {
      // Tag the runner's connections so other sessions on a shared test
      // database cannot skew the count.
      const tagged = `${url}${url.includes("?") ? "&" : "?"}application_name=${schema}`;
      writeFileSync(
        join(root, ".cronfish.json"),
        JSON.stringify({ store: { type: "postgres", url: tagged, schema } }),
      );
      const seen = join(root, "seen.json");
      mkdirSync(join(root, "cron"), { recursive: true });
      const job = join(root, "cron", "count-backends.ts");
      writeFileSync(
        job,
        `export const config = { schedule: "manual", enabled: true, timeout: 30 };
export default async function run() {
  const sql = new Bun.SQL(${JSON.stringify(url)});
  const rows = await sql.unsafe(
    "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
    [${JSON.stringify(schema)}],
  );
  await sql.end();
  await Bun.write(${JSON.stringify(seen)}, JSON.stringify(rows.map((r) => Number(r.pid))));
}
`,
      );

      const proc = Bun.spawnSync(["bun", RUNNER, job], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: root,
        env: {
          ...process.env,
          CRONFISH_CONSUMER_ROOT: root,
          CRONFISH_TRIGGER: "manual",
        },
      });
      expect(proc.exitCode).toBe(0);

      // Mid-run, after the start-of-run ledger writes, the runner held one.
      const midRun = JSON.parse(readFileSync(seen, "utf-8")) as number[];
      expect(midRun.length).toBe(1);

      const probe = newBunSql(url);
      try {
        // The run finished and the ledger says so.
        const inv = await probe.unsafe(
          `SELECT i.status FROM "${schema}".cron_invocations i
             JOIN "${schema}".cron_jobs j ON j.id = i.job_id
            WHERE j.slug = 'count-backends-ts'`,
        );
        expect(inv.map((r) => r.status)).toEqual(["ok"]);
        // And nothing outlives the runner process.
        const left = await probe.unsafe(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
          [schema],
        );
        expect(left.length).toBe(0);
      } finally {
        await probe.end();
      }
      // Spawns a real runner, like the runner.test.ts siblings.
    }, 20_000);
  });
}
