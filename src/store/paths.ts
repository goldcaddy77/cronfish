// Pure path helpers for the cronfish store. No I/O, no bun:sqlite — safe to
// import from anywhere (CLI, prune, tests) without pulling in a DB driver.

import { join } from "node:path";

export function dbPath(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "db.sqlite");
}

export function logsRoot(consumerRoot: string): string {
  return join(consumerRoot, ".cronfish", "logs");
}
