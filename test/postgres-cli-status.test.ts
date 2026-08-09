// Regression: the CLI's read paths must dispatch on the CONFIGURED backend, not
// on whether a local SQLite file happens to exist (CAD-1104).
//
// `cronfish status` reported "daemon: not running (no heartbeat)" for 20 days
// against a daemon ticking at 1 Hz, because three read paths in cli.ts gated on
// `existsSync(.cronfish/db.sqlite)` before dispatching. On a Postgres consumer
// that file never exists, so the guard was not flaky — it was permanently wrong
// and silent. `cronfish sync` then refused to fall back to per-job plists on the
// same false signal, which is a behavioural consequence, not a cosmetic one.
//
// These tests drive the real CLI as a subprocess against a Postgres store with
// NO sqlite file on disk, and assert both directions: a fresh heartbeat reads
// LIVE, and a genuinely absent one still reads "not running". A status check
// that cannot say "alive" when things are fine can never be trusted to say
// "dead" when they are not.
//
// Gated on a reachable Postgres, like postgres-store.test.ts — skipped as an
// empty describe when none is available, so the suite stays green without it.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

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
    : ["postgres://localhost:5432/postgres", "postgres://localhost:5432/agent"];
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
  describe.skip("postgres cli status [no postgres]", () => {
    test("skipped", () => {});
  });
} else {
  const url = PG_URL;

  describe("cli read paths on a postgres consumer", () => {
    function ephemeral(): string {
      return `cronfish_test_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    }

    // A consumer root configured for Postgres and deliberately WITHOUT a
    // .cronfish/db.sqlite — exactly the Mac Mini's shape after its 2026-07-20
    // cutover, and the shape the old guard could not see.
    function setup(schema: string): { root: string; base: string } {
      const base = mkdtempSync(join(tmpdir(), "cronfish-pgcli-"));
      const root = join(base, "consumer");
      mkdirSync(join(root, "cron"), { recursive: true });
      writeFileSync(
        join(root, ".cronfish.json"),
        JSON.stringify({
          bundle_prefix: `com.cronfish.test.${schema}`,
          store: { type: "postgres", url_env: "CRONFISH_TEST_STORE_URL", schema },
        }),
      );
      return { root, base };
    }

    function runCli(root: string, args: string[]): { code: number; out: string } {
      const proc = Bun.spawnSync(["bun", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: root,
        env: {
          ...process.env,
          CRONFISH_CONSUMER_ROOT: root,
          CRONFISH_TEST_STORE_URL: url,
        },
      });
      return {
        code: proc.exitCode ?? 0,
        out:
          new TextDecoder().decode(proc.stdout) +
          new TextDecoder().decode(proc.stderr),
      };
    }

    async function dropSchema(schema: string): Promise<void> {
      const sql = newBunSql(url);
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await sql.end();
      }
    }

    test("a fresh heartbeat in postgres reads LIVE, with no sqlite file present", async () => {
      const schema = ephemeral();
      const { root, base } = setup(schema);
      try {
        const { PostgresStore } = await import("../src/store/index.ts");
        const store = await PostgresStore.open({ url, schema });
        await store.beatDaemonHeartbeat({
          pid: 424242,
          startedAt: new Date().toISOString(),
          version: "0.19.0",
        });
        await store.close();

        // The precondition that broke it: there is no sqlite file, and nothing
        // in a read path may create one.
        expect(existsSync(join(root, ".cronfish", "db.sqlite"))).toBe(false);

        const { out } = runCli(root, ["status"]);
        expect(out).toContain("daemon: LIVE");
        expect(out).toContain("pid=424242");
        expect(out).not.toContain("not running (no heartbeat)");

        // Read paths stay side-effect free: still no sqlite file, still no
        // .cronfish/ conjured on a consumer that does not use one.
        expect(existsSync(join(root, ".cronfish", "db.sqlite"))).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
        await dropSchema(schema);
      }
    });

    test("a genuinely absent heartbeat still reads not-running", async () => {
      const schema = ephemeral();
      const { root, base } = setup(schema);
      try {
        // Migrate the schema so the store is reachable and healthy — the only
        // thing missing is the heartbeat row itself, i.e. a daemon that has
        // genuinely never run. The false-negative fix must not become a
        // false POSITIVE.
        const { PostgresStore } = await import("../src/store/index.ts");
        const store = await PostgresStore.open({ url, schema });
        await store.close();

        const { out } = runCli(root, ["status"]);
        expect(out).toContain("not running (no heartbeat)");
        expect(out).not.toContain("daemon: LIVE");
      } finally {
        rmSync(base, { recursive: true, force: true });
        await dropSchema(schema);
      }
    });

    test("a stale heartbeat reads STALE, not LIVE and not absent", async () => {
      const schema = ephemeral();
      const { root, base } = setup(schema);
      try {
        const { PostgresStore } = await import("../src/store/index.ts");
        const store = await PostgresStore.open({ url, schema });
        await store.beatDaemonHeartbeat({
          pid: 515151,
          startedAt: new Date(Date.now() - 3_600_000).toISOString(),
          version: "0.19.0",
        });
        await store.close();

        // Age the last tick past the 10s freshness window. A wedged daemon and
        // an absent one are different facts and must print differently.
        const sql = newBunSql(url);
        try {
          await sql.unsafe(
            `UPDATE "${schema}".cron_daemon_heartbeat SET last_tick_at = $1 WHERE id = 1`,
            [new Date(Date.now() - 600_000).toISOString()],
          );
        } finally {
          await sql.end();
        }

        const { out } = runCli(root, ["status"]);
        expect(out).toContain("daemon: STALE");
        expect(out).toContain("pid=515151");
      } finally {
        rmSync(base, { recursive: true, force: true });
        await dropSchema(schema);
      }
    });
  });
}
