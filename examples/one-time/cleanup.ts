// One-shot TypeScript job. Like a recurring `.ts` it exports a top-level `config`
// object and a default async function — but the config carries `run_at:` instead of
// `schedule:`. Fires exactly once at `run_at`, then archives itself to
// `~/Library/Application Support/cronfish/done/` (outside the repo).
//
// One-time jobs MUST be idempotent: launchd can re-fire on restart, unsleep, or load
// spikes. Cronfish takes a flock and checks `executed_at` before invoking you, but the
// window between "start" and "stamp" can still repeat — so make the work safe to redo.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const config = {
  run_at: "+1h", // relative to file mtime (s|m|h|d), OR an absolute ISO timestamp
  enabled: false, // flip on with `cronfish enable one-time/cleanup-ts`
  timeout: 120,
};

export default async function run(): Promise<void> {
  // Deleting an already-deleted path is a no-op — naturally idempotent.
  const stale = join(tmpdir(), "my-app-scratch");
  await rm(stale, { recursive: true, force: true });
  console.log(`cleaned ${stale}`);
}
