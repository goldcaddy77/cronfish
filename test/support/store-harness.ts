// Dual-dialect test harness for the CronStore seam.
//
// BACKENDS is the list of store implementations the dialect-neutral behavioral
// suites run against via `describe.each`. Today it is SQLite only; adding a
// PostgresStore later means adding one row here and the whole shared suite runs
// against it — that is the entire point of the seam. Migration-ladder tests
// that assert SQLite PRAGMA user_version / ALTER mechanics stay SQLite-specific
// and do NOT use this harness.

import { Database } from "bun:sqlite";
import { SqliteStore, type CronStore } from "../../src/store/index.ts";

export type StoreFactory = () => Promise<{
  store: CronStore;
  // The raw driver handle for tests that seed/assert via dialect SQL. `null`
  // for a backend with no such escape hatch.
  raw: Database | null;
  dispose: () => Promise<void>;
}>;

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
    dispose: async () => {
      await store.close();
    },
  };
};

export const BACKENDS: [string, StoreFactory][] = [["sqlite", sqliteMemoryFactory]];
