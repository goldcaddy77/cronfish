// Dual-dialect test harness for the CronStore seam.
//
// BACKENDS is the list of store implementations the dialect-neutral behavioral
// suites run against via `describe.each`. SQLite is always present; Postgres is
// added ONLY when a test database is reachable (see pgAvailability below) —
// gated so the suite still passes green for OSS contributors / CI WITHOUT a
// Postgres. Migration-ladder tests that assert SQLite PRAGMA user_version /
// ALTER mechanics stay SQLite-specific and do NOT use this harness.
//
// The shared behavioral suite must seed and assert without speaking a dialect,
// so each factory returns a `kit` of neutral helpers (seedInvocation, a handful
// of typed reads, and an age-request mutation) that the suite calls instead of
// touching a bun:sqlite handle directly. `raw` stays available for the SQLite
// migration-mechanics tests only.

import { Database } from "bun:sqlite";
import { PostgresStore, SqliteStore, type CronStore } from "../../src/store/index.ts";

// Neutral seed/read helpers the shared suite uses, implemented per dialect so
// no test speaks SQL for a specific backend.
export interface StoreKit {
  // Seed a finished (or running) invocation with an explicit duration — the
  // stats/history tests need known numbers the store's own finishInvocation
  // wouldn't produce deterministically.
  seedInvocation(
    jobId: number,
    opts: {
      startedAt: string;
      status: string;
      durationMs?: number | null;
      trigger?: string;
    },
  ): Promise<void>;
  // Typed reads used by the assertions (return the exact JS shapes the SQLite
  // path produced — numbers as numbers, nulls as null).
  jobFields(
    slug: string,
    cols: string[],
  ): Promise<Record<string, unknown> | null>;
  listJobStates(): Promise<{ slug: string; state: string }[]>;
  runRequestFields(
    id: number,
    cols: string[],
  ): Promise<Record<string, unknown> | null>;
  invocationFields(
    id: number,
    cols: string[],
  ): Promise<Record<string, unknown> | null>;
  // Age a run request's requested_at so the expiry-window test can fire it.
  ageRunRequest(id: number, requestedAt: string): Promise<void>;

  // --- Ledger-prune seed helpers (prune-ledger.test.ts) ---
  // A raw job insert with an explicit state/schedule — bypasses upsertJob so a
  // test can seed a 'deleted' job or an exact schedule string. Returns the id.
  addJob(slug: string, state: string, nowIso: string): Promise<number>;
  addInvocation(
    jobId: number,
    startedAtIso: string,
    status: string,
  ): Promise<number>;
  addRunRequest(
    jobId: number,
    requestedAtIso: string,
    invId: number | null,
  ): Promise<number>;
  addMissedAlert(jobId: number, atIso: string): Promise<void>;
  count(table: "cron_invocations" | "cron_run_requests" | "cron_missed_alerts" | "cron_jobs"): Promise<number>;
  // The two ad-hoc joins the prune tests assert on.
  invocationSlugs(): Promise<string[]>;
  invocationIds(): Promise<number[]>;
  runRequestInvocationId(id: number): Promise<number | null>;
}

export type StoreFactory = () => Promise<{
  store: CronStore;
  // The raw bun:sqlite handle for the SQLite migration-mechanics tests. `null`
  // for a backend with no such escape hatch (postgres).
  raw: Database | null;
  kit: StoreKit;
  dispose: () => Promise<void>;
}>;

const SELECTABLE = /^[a-z_][a-z0-9_]*$/i;
function assertCols(cols: string[]): void {
  for (const c of cols) {
    if (!SELECTABLE.test(c)) throw new Error(`unsafe test column: ${c}`);
  }
}

// --- SQLite backend (always present) ---

function sqliteKit(db: Database): StoreKit {
  return {
    async seedInvocation(jobId, opts) {
      db.prepare(
        `INSERT INTO cron_invocations
           (job_id, started_at, finished_at, status, trigger, log_path, duration_ms)
         VALUES ($job_id, $started_at, $finished_at, $status, $trigger, '/tmp/x.log', $duration_ms)`,
      ).run({
        $job_id: jobId,
        $started_at: opts.startedAt,
        $finished_at: opts.status === "running" ? null : opts.startedAt,
        $status: opts.status,
        $trigger: opts.trigger ?? "schedule",
        $duration_ms: opts.durationMs ?? null,
      });
    },
    async jobFields(slug, cols) {
      assertCols(cols);
      return (
        (db
          .query(`SELECT ${cols.join(", ")} FROM cron_jobs WHERE slug = $slug`)
          .get({ $slug: slug }) as Record<string, unknown> | undefined) ?? null
      );
    },
    async listJobStates() {
      return db
        .query("SELECT slug, state FROM cron_jobs ORDER BY slug")
        .all() as { slug: string; state: string }[];
    },
    async runRequestFields(id, cols) {
      assertCols(cols);
      return (
        (db
          .query(
            `SELECT ${cols.join(", ")} FROM cron_run_requests WHERE id = $id`,
          )
          .get({ $id: id }) as Record<string, unknown> | undefined) ?? null
      );
    },
    async invocationFields(id, cols) {
      assertCols(cols);
      return (
        (db
          .query(
            `SELECT ${cols.join(", ")} FROM cron_invocations WHERE id = $id`,
          )
          .get({ $id: id }) as Record<string, unknown> | undefined) ?? null
      );
    },
    async ageRunRequest(id, requestedAt) {
      db.prepare(
        "UPDATE cron_run_requests SET requested_at = $t WHERE id = $id",
      ).run({ $t: requestedAt, $id: id });
    },
    async addJob(slug, state, now) {
      const res = db
        .prepare(
          `INSERT INTO cron_jobs (slug, kind, schedule, enabled, last_synced_at, state)
           VALUES ($slug, 'md', 'every 30 seconds', 1, $now, $state)`,
        )
        .run({ $slug: slug, $now: now, $state: state });
      return Number(res.lastInsertRowid);
    },
    async addInvocation(jobId, startedAt, status) {
      const res = db
        .prepare(
          `INSERT INTO cron_invocations (job_id, started_at, status, trigger, log_path)
           VALUES ($job, $started, $status, 'schedule', '/tmp/x.log')`,
        )
        .run({ $job: jobId, $started: startedAt, $status: status });
      return Number(res.lastInsertRowid);
    },
    async addRunRequest(jobId, requestedAt, invId) {
      const res = db
        .prepare(
          `INSERT INTO cron_run_requests (job_id, trigger, requested_at, invocation_id)
           VALUES ($job, 'manual', $at, $inv)`,
        )
        .run({ $job: jobId, $at: requestedAt, $inv: invId });
      return Number(res.lastInsertRowid);
    },
    async addMissedAlert(jobId, at) {
      db.prepare(
        `INSERT INTO cron_missed_alerts (job_id, expected_at, fired_at)
         VALUES ($job, $at, $at)`,
      ).run({ $job: jobId, $at: at });
    },
    async count(table) {
      return (
        db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n;
    },
    async invocationSlugs() {
      return (
        db
          .query(
            `SELECT j.slug FROM cron_invocations i JOIN cron_jobs j ON j.id = i.job_id`,
          )
          .all() as { slug: string }[]
      ).map((r) => r.slug);
    },
    async invocationIds() {
      return (
        db.query("SELECT id FROM cron_invocations ORDER BY id").all() as {
          id: number;
        }[]
      ).map((r) => r.id);
    },
    async runRequestInvocationId(id) {
      const row = db
        .query("SELECT invocation_id FROM cron_run_requests WHERE id = $id")
        .get({ $id: id }) as { invocation_id: number | null } | undefined;
      return row?.invocation_id ?? null;
    },
  };
}

// An in-memory SQLite store with the exact WAL-less :memory: setup the real
// openStore uses (foreign_keys ON, migrated to head).
export const sqliteMemoryFactory: StoreFactory = async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const store = new SqliteStore(db);
  await store.migrate();
  return {
    store,
    raw: db,
    kit: sqliteKit(db),
    dispose: async () => {
      await store.close();
    },
  };
};

// --- Postgres backend (present only when a test DB is reachable) ---

interface BunSqlLike {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<unknown[]>;
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

function newBunSql(url: string): BunSqlLike {
  const SQL = (Bun as unknown as { SQL: new (url: string) => BunSqlLike }).SQL;
  return new SQL(url);
}

// A Postgres value comes back as string for BIGINT/numeric; the shared
// assertions compare against JS numbers, so coerce the numeric columns the
// tests read. Column → coercer map keeps the neutral reads shape-identical to
// SQLite's.
const PG_NUMERIC_COLS = new Set([
  "attempt",
  "duration_ms",
  "invocation_id",
  "file_size",
  "id",
  "job_id",
]);
function coercePgRow(
  row: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      PG_NUMERIC_COLS.has(k) && v !== null && v !== undefined
        ? Number(v)
        : v;
  }
  return out;
}

function pgKit(sql: BunSqlLike, schema: string): StoreKit {
  const s = `"${schema}"`;
  const sel = (table: string, cols: string[], id: number, idcol = "id") => {
    assertCols(cols);
    return sql
      .unsafe(
        `SELECT ${cols.join(", ")} FROM ${s}.${table} WHERE ${idcol} = $1`,
        [id],
      )
      .then((rows) => coercePgRow(rows[0]));
  };
  return {
    async seedInvocation(jobId, opts) {
      await sql.unsafe(
        `INSERT INTO ${s}.cron_invocations
           (job_id, started_at, finished_at, status, trigger, log_path, duration_ms)
         VALUES ($1, $2, $3, $4, $5, '/tmp/x.log', $6)`,
        [
          jobId,
          opts.startedAt,
          opts.status === "running" ? null : opts.startedAt,
          opts.status,
          opts.trigger ?? "schedule",
          opts.durationMs ?? null,
        ],
      );
    },
    async jobFields(slug, cols) {
      assertCols(cols);
      const rows = await sql.unsafe(
        `SELECT ${cols.join(", ")} FROM ${s}.cron_jobs WHERE slug = $1`,
        [slug],
      );
      return coercePgRow(rows[0]);
    },
    async listJobStates() {
      const rows = await sql.unsafe(
        `SELECT slug, state FROM ${s}.cron_jobs ORDER BY slug`,
      );
      return rows as { slug: string; state: string }[];
    },
    runRequestFields(id, cols) {
      return sel("cron_run_requests", cols, id);
    },
    invocationFields(id, cols) {
      return sel("cron_invocations", cols, id);
    },
    async ageRunRequest(id, requestedAt) {
      await sql.unsafe(
        `UPDATE ${s}.cron_run_requests SET requested_at = $1 WHERE id = $2`,
        [requestedAt, id],
      );
    },
    async addJob(slug, state, now) {
      const rows = await sql.unsafe(
        `INSERT INTO ${s}.cron_jobs (slug, kind, schedule, enabled, last_synced_at, state)
         VALUES ($1, 'md', 'every 30 seconds', 1, $2, $3) RETURNING id`,
        [slug, now, state],
      );
      return Number(rows[0]!.id);
    },
    async addInvocation(jobId, startedAt, status) {
      const rows = await sql.unsafe(
        `INSERT INTO ${s}.cron_invocations (job_id, started_at, status, trigger, log_path)
         VALUES ($1, $2, $3, 'schedule', '/tmp/x.log') RETURNING id`,
        [jobId, startedAt, status],
      );
      return Number(rows[0]!.id);
    },
    async addRunRequest(jobId, requestedAt, invId) {
      const rows = await sql.unsafe(
        `INSERT INTO ${s}.cron_run_requests (job_id, trigger, requested_at, invocation_id)
         VALUES ($1, 'manual', $2, $3) RETURNING id`,
        [jobId, requestedAt, invId],
      );
      return Number(rows[0]!.id);
    },
    async addMissedAlert(jobId, at) {
      await sql.unsafe(
        `INSERT INTO ${s}.cron_missed_alerts (job_id, expected_at, fired_at)
         VALUES ($1, $2, $2)`,
        [jobId, at],
      );
    },
    async count(table) {
      const rows = await sql.unsafe(
        `SELECT COUNT(*) AS n FROM ${s}.${table}`,
      );
      return Number(rows[0]!.n);
    },
    async invocationSlugs() {
      const rows = await sql.unsafe(
        `SELECT j.slug FROM ${s}.cron_invocations i JOIN ${s}.cron_jobs j ON j.id = i.job_id`,
      );
      return rows.map((r) => r.slug as string);
    },
    async invocationIds() {
      const rows = await sql.unsafe(
        `SELECT id FROM ${s}.cron_invocations ORDER BY id`,
      );
      return rows.map((r) => Number(r.id));
    },
    async runRequestInvocationId(id) {
      const rows = await sql.unsafe(
        `SELECT invocation_id FROM ${s}.cron_run_requests WHERE id = $1`,
        [id],
      );
      const v = rows[0]?.invocation_id;
      return v === null || v === undefined ? null : Number(v);
    },
  };
}

// Resolve the test Postgres URL: explicit env var wins, else probe the two
// common local defaults. Returns null (with a skip log) when none connect, so
// the suite still passes without Postgres.
async function resolvePgUrl(): Promise<string | null> {
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
      // try next candidate
    }
  }
  return null;
}

// A per-run ephemeral schema so tests never pollute a real schema and parallel
// runs never collide.
function ephemeralSchema(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `cronfish_test_${Date.now().toString(36)}_${rand}`;
}

function makePgFactory(url: string): StoreFactory {
  return async () => {
    const schema = ephemeralSchema();
    const store = await PostgresStore.open({ url, schema });
    // A dedicated raw handle for the kit's seed/read helpers (the store owns
    // its own connection; sharing would leak internals).
    const sql = newBunSql(url);
    return {
      store,
      raw: null,
      kit: pgKit(sql, schema),
      dispose: async () => {
        try {
          await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await sql.end();
          await store.close();
        }
      },
    };
  };
}

// Build BACKENDS once at module load. `describe.each` needs the array
// synchronously, so we resolve Postgres availability with a top-level await.
const BACKENDS_LIST: [string, StoreFactory][] = [["sqlite", sqliteMemoryFactory]];

const pgUrl = await resolvePgUrl();
if (pgUrl) {
  BACKENDS_LIST.push(["postgres", makePgFactory(pgUrl)]);
} else {
  // One line so a run without Postgres is self-explanatory, not silently sqlite-only.
  console.log(
    "[store-harness] Postgres not reachable (set CRONFISH_TEST_PG_URL) — skipping postgres backend tests.",
  );
}

export const BACKENDS: [string, StoreFactory][] = BACKENDS_LIST;
