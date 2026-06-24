// Recurring TypeScript job. Cronfish runs this with `bun`, cwd = your repo root,
// and captures stdout/stderr to the per-run log. Bun auto-loads your `.env`, so
// process.env.* is populated. Export a `config` and a default async function.

export const config = {
  schedule: "every 15 minutes", // human shape; also accepts cron / "15m" / 900
  enabled: false, // flip on with `cronfish enable healthcheck-ts`
  timeout: 30, // seconds
  retries: 1, // retry once on non-zero exit (5s backoff)
  concurrency: "skip" as const, // if a prior run is still going, exit 0
};

// Point this at whatever you want to watch. Override via env without editing the file.
const TARGET = process.env.HEALTHCHECK_URL ?? "https://example.com";

export default async function run(): Promise<void> {
  const started = Date.now();
  const res = await fetch(TARGET, { method: "GET", signal: AbortSignal.timeout(10_000) });
  const ms = Date.now() - started;

  if (!res.ok) {
    // A non-zero exit marks the run `fail` — your configured alert adapter fires.
    throw new Error(`${TARGET} returned ${res.status} ${res.statusText} (${ms}ms)`);
  }

  console.log(`ok ${res.status} ${TARGET} ${ms}ms`);
}
