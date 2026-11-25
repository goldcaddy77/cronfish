// Postgres-specific store tests: the migration bookkeeping table (the Postgres
// analogue of SQLite's PRAGMA user_version) and the schema-identifier injection
// guard. Gated on a reachable test Postgres — skipped (as an empty describe)
// when none is available, so the suite stays green without Postgres.

import { describe, expect, test } from "bun:test";
import { PostgresStore } from "../src/store/index.ts";
import {
  DEFAULT_POOL_IDLE_TIMEOUT_S,
  DEFAULT_POOL_MAX,
  RUNNER_POOL,
  poolOptions,
} from "../src/store/postgres.ts";
import { assertPgIdentifier } from "../src/store/postgres-queries.ts";
import { resolvePgUrl, waitFor } from "./support/store-harness.ts";

interface BunSqlLike {
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}
function newBunSql(url: string): BunSqlLike {
  const SQL = (Bun as unknown as { SQL: new (url: string) => BunSqlLike }).SQL;
  return new SQL(url);
}

const PG_URL = await resolvePgUrl();

// The injection guard is pure — validate it even without a live Postgres.
describe("postgres identifier guard", () => {
  test("accepts valid identifiers, rejects injection attempts", () => {
    expect(() => assertPgIdentifier("cron")).not.toThrow();
    expect(() => assertPgIdentifier("cron_test_123")).not.toThrow();
    for (const bad of [
      "cron; DROP TABLE x",
      'cron"',
      "cron schema",
      "1cron",
      "cron-x",
      "",
    ]) {
      expect(() => assertPgIdentifier(bad)).toThrow();
    }
  });
});

// The pool bound is pure too: defaults are small, callers can override.
describe("postgres pool options", () => {
  test("defaults are a small pool with an idle timeout", () => {
    expect(DEFAULT_POOL_MAX).toBe(2);
    expect(DEFAULT_POOL_IDLE_TIMEOUT_S).toBe(20);
    expect(poolOptions({ url: "postgres://x/y" })).toEqual({
      url: "postgres://x/y",
      max: 2,
      idleTimeout: 20,
    });
  });

  test("the runner pool is one connection that never idles out", () => {
    expect(RUNNER_POOL).toEqual({ max: 1, idleTimeout: 0 });
    expect(poolOptions({ url: "postgres://x/y", ...RUNNER_POOL })).toEqual({
      url: "postgres://x/y",
      max: 1,
      idleTimeout: 0,
    });
  });

  test("caller overrides reach the pool options", () => {
    expect(
      poolOptions({ url: "postgres://x/y", max: 5, idleTimeout: 3 }),
    ).toEqual({ url: "postgres://x/y", max: 5, idleTimeout: 3 });
  });
});

if (!PG_URL) {
  describe.skip("postgres migration bookkeeping [no postgres]", () => {
    test("skipped", () => {});
  });
} else {
  const url = PG_URL;
  describe("postgres migration bookkeeping", () => {
    function ephemeral(): string {
      return `cronfish_test_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    }

    async function dropSchema(schema: string): Promise<void> {
      const sql = newBunSql(url);
      try {
        await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await sql.end();
      }
    }

    test("fresh open stamps cron_migrations at version 1 with the final schema", async () => {
      const schema = ephemeral();
      const store = await PostgresStore.open({ url, schema });
      try {
        const sql = newBunSql(url);
        try {
          const versions = await sql.unsafe(
            `SELECT version FROM "${schema}".cron_migrations ORDER BY version`,
          );
          expect(versions.map((r) => Number(r.version))).toEqual([1]);

          // The final v6-equivalent tables all exist.
          const tables = await sql.unsafe(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
            [schema],
          );
          const names = tables.map((r) => r.table_name as string);
          for (const t of [
            "cron_jobs",
            "cron_invocations",
            "cron_run_requests",
            "cron_daemon_heartbeat",
            "cron_missed_alerts",
            "cron_migrations",
          ]) {
            expect(names).toContain(t);
          }
        } finally {
          await sql.end();
        }
      } finally {
        await store.close();
        await dropSchema(schema);
      }
    });

    test("re-opening the same schema is idempotent (migration not re-applied)", async () => {
      const schema = ephemeral();
      const first = await PostgresStore.open({ url, schema });
      await first.close();
      const second = await PostgresStore.open({ url, schema });
      try {
        const sql = newBunSql(url);
        try {
          const versions = await sql.unsafe(
            `SELECT version FROM "${schema}".cron_migrations`,
          );
          // Still exactly one row — the ladder saw version 1 already applied.
          expect(versions.length).toBe(1);
        } finally {
          await sql.end();
        }
      } finally {
        await second.close();
        await dropSchema(schema);
      }
    });

    test("a store holds at most the pool max in backends and releases them when idle", async () => {
      const schema = ephemeral();
      // Tag this store's backends so other sessions on a shared test database
      // cannot skew the count.
      const tagged = `${url}${url.includes("?") ? "&" : "?"}application_name=${schema}`;
      const store = await PostgresStore.open({
        url: tagged,
        schema,
        max: 2,
        idleTimeout: 1,
      });
      const probe = newBunSql(url);
      const count = async () =>
        Number(
          (
            await probe.unsafe(
              "SELECT count(*) AS c FROM pg_stat_activity WHERE application_name = $1",
              [schema],
            )
          )[0]!.c,
        );
      try {
        // Concurrent statements must queue on the small pool, not fail.
        await Promise.all(
          Array.from({ length: 8 }, () => store.listEnabledJobs()),
        );
        expect(await count()).toBeLessThanOrEqual(2);
        await Bun.sleep(2500);
        expect(await count()).toBe(0);
      } finally {
        await probe.end();
        await store.close();
        await dropSchema(schema);
      }
    });

    test("a runner-pool store does a whole run's ledger work on one backend", async () => {
      const schema = ephemeral();
      const tagged = `${url}${url.includes("?") ? "&" : "?"}application_name=${schema}`;
      const probe = newBunSql(url);
      const backends = async () =>
        (
          await probe.unsafe(
            "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
            [schema],
          )
        ).map((r) => Number(r.pid));
      // A fresh schema, so open() also runs the migration transaction.
      const store = await PostgresStore.open({
        url: tagged,
        schema,
        ...RUNNER_POOL,
      });
      try {
        const opened = await backends();
        expect(opened.length).toBe(1);

        // The runner's ledger sequence, start to finish, with concurrent
        // statements thrown in: they must queue on the one slot, not fail.
        await store.upsertJob({
          slug: "pool-probe",
          path: "/tmp/pool-probe.ts",
          kind: "ts",
          enabled: true,
          schedule: "manual",
        });
        const jobId = (await store.getJobIdBySlug("pool-probe"))!;
        const inv = await store.startInvocation(jobId, "manual", "/tmp/x.log");
        await Promise.all([
          store.setInvocationLogPath(inv, "/tmp/y.log"),
          store.listEnabledJobs(),
          store.getJobIdBySlug("pool-probe"),
        ]);
        // Idle past a short timeout: the runner pool must keep its backend
        // rather than close it and reconnect for the finish writes.
        await Bun.sleep(1500);
        await store.finishInvocation(inv, "ok", 0);
        await store.setJobLastRun(jobId, new Date().toISOString(), "ok");
        await store.getPreviousFinishedStatus(jobId, inv);

        expect(await backends()).toEqual(opened);
        await store.close();
        // A backend leaves pg_stat_activity shortly after its client hangs up.
        expect(await waitFor(async () => (await backends()).length === 0)).toBe(
          true,
        );
      } finally {
        await store.close();
        await probe.end();
        await dropSchema(schema);
      }
    }, 15_000);

    test("an invalid schema name is rejected before any DDL runs", async () => {
      await expect(
        PostgresStore.open({ url, schema: "bad; DROP TABLE x" }),
      ).rejects.toThrow();
    });
  });
}
