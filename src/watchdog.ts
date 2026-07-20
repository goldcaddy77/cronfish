// Watchdog: detect crons that should have fired but didn't.
//
// One alert per miss window: after firing a `missed` for a job, stay quiet
// until the job runs successfully again (which resets the baseline by way of
// last_ok advancing past any earlier `missed` row).
//
// Cold-start: jobs with zero successful runs are skipped — brand-new crons
// don't ping until they've succeeded at least once.

import { join } from "node:path";
import {
  buildRegistry,
  loadConsumerAlertsConfig,
  safeNotify,
  type AlertPayload,
} from "./alerts/index.ts";
import { chooseAdapterName, buildUiUrl } from "./alerts/dispatch.ts";
import { openStore, type CronStore } from "./store/index.ts";
import { discoverJobs } from "./jobs.ts";
import {
  intervalSecondsAt,
  nextFireAfter,
  parseMissedAfter,
} from "./schedule.ts";

const DEFAULT_GRACE_FLOOR_S = 600;

export interface WatchdogDecision {
  slug: string;
  outcome: "skipped-cold" | "skipped-manual" | "skipped-on-time" |
           "skipped-already-fired" | "skipped-no-adapter" |
           "skipped-down-window" | "fired" | "fire-failed";
  expected_at?: string;
  grace_s?: number;
  error?: string;
}

export interface WatchdogInput {
  consumerRoot: string;
  now?: Date;
  // Reuse an already-open ledger (the in-daemon caller passes its own store);
  // left open on return. Omitted → open + close the consumer store as before.
  store?: CronStore;
  // Daemon mode: a miss whose expected fire time predates the daemon's own
  // start is a downtime gap first — the catch-up dispatch gets one grace
  // window (measured from liveSince) to make the run happen. Past that the
  // miss alerts like any other: a restart delays detection, never mutes it.
  liveSince?: Date;
}

export async function runWatchdog(
  input: WatchdogInput,
): Promise<WatchdogDecision[]> {
  const now = input.now ?? new Date();
  const cronDir = join(input.consumerRoot, "cron");
  const { jobs } = discoverJobs(cronDir);
  const jobBySlug = new Map(jobs.map((j) => [j.slug, j]));

  const ownStore = input.store === undefined;
  const store = input.store ?? (await openStore(input.consumerRoot));
  const cfg = loadConsumerAlertsConfig(input.consumerRoot);
  const registry = buildRegistry(cfg.alerts);
  const decisions: WatchdogDecision[] = [];

  try {
    const rows = await store.listEnabledJobs();
    for (const row of rows) {
      const job = jobBySlug.get(row.slug);
      if (!job) continue;
      if (row.schedule === "manual") {
        decisions.push({ slug: row.slug, outcome: "skipped-manual" });
        continue;
      }
      const lastOk = await store.getLastOkStartedAt(row.id);
      if (!lastOk) {
        decisions.push({ slug: row.slug, outcome: "skipped-cold" });
        continue;
      }
      const lastOkDate = new Date(lastOk);
      const expected = nextFireAfter(job.schedule, lastOkDate);
      if (!expected) {
        decisions.push({ slug: row.slug, outcome: "skipped-manual" });
        continue;
      }
      const intervalS = intervalSecondsAt(job.schedule, expected) ?? 60;
      const overrideS = parseMissedAfter(job.missed_after);
      const graceS = overrideS ?? Math.max(2 * intervalS, DEFAULT_GRACE_FLOOR_S);
      // A miss whose expected time predates liveSince started as a downtime
      // gap — but it must NOT be muted forever (a daemon restart would
      // otherwise re-mute a real fault every time). liveSince becomes the
      // effective expected time: catch-up dispatch gets one grace window
      // after startup to make the run happen; past that, it's a real miss.
      const inDownWindow = !!input.liveSince && expected < input.liveSince;
      const effectiveExpected = inDownWindow ? input.liveSince! : expected;
      const deadline = new Date(effectiveExpected.getTime() + graceS * 1000);
      if (now < deadline) {
        decisions.push({
          slug: row.slug,
          outcome: inDownWindow ? "skipped-down-window" : "skipped-on-time",
          expected_at: expected.toISOString(),
          grace_s: graceS,
        });
        continue;
      }
      const lastMissed = await store.getLatestMissedFiredAt(row.id);
      if (lastMissed && new Date(lastMissed) > lastOkDate) {
        decisions.push({
          slug: row.slug,
          outcome: "skipped-already-fired",
          expected_at: expected.toISOString(),
          grace_s: graceS,
        });
        continue;
      }
      const adapterName = chooseAdapterName(job.on_failure, cfg.alerts);
      if (!adapterName || !registry.has(adapterName)) {
        decisions.push({
          slug: row.slug,
          outcome: "skipped-no-adapter",
          expected_at: expected.toISOString(),
          grace_s: graceS,
        });
        continue;
      }
      const payload: AlertPayload = {
        slug: row.slug,
        status: "missed",
        exit_code: null,
        duration_ms: null,
        started_at: expected.toISOString(),
        log_tail: `expected at ${expected.toISOString()}, grace ${graceS}s, last ok ${lastOk}`,
        ui_url: jobUiUrl(cfg, row.slug),
      };
      const outcome = await safeNotify(registry.get(adapterName), payload);
      if (outcome.status === "sent") {
        await store.recordMissedAlert(row.id, expected.toISOString());
        decisions.push({
          slug: row.slug,
          outcome: "fired",
          expected_at: expected.toISOString(),
          grace_s: graceS,
        });
      } else {
        decisions.push({
          slug: row.slug,
          outcome: "fire-failed",
          expected_at: expected.toISOString(),
          grace_s: graceS,
          error: outcome.error ?? "unknown",
        });
      }
    }
  } finally {
    if (ownStore) {
      try {
        await store.close();
      } catch {}
    }
  }
  return decisions;
}

function jobUiUrl(
  cfg: ReturnType<typeof loadConsumerAlertsConfig>,
  slug: string,
): string | null {
  const base = cfg.ui?.public_url?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/jobs/${encodeURIComponent(slug)}`;
}

// Pure decision helper for unit tests — no DB / no IO.
export interface DecisionInput {
  now: Date;
  schedule: string | number | undefined;
  lastOk: string | null;
  lastMissedFiredAt: string | null;
  missedAfter?: string;
  adapterConfigured: boolean;
  liveSince?: Date; // see WatchdogInput.liveSince
}

export function decideWatchdog(input: DecisionInput): {
  outcome: WatchdogDecision["outcome"];
  expected?: Date;
  grace_s?: number;
} {
  if (input.schedule === "manual" || input.schedule === undefined) {
    return { outcome: "skipped-manual" };
  }
  if (!input.lastOk) return { outcome: "skipped-cold" };
  const lastOkDate = new Date(input.lastOk);
  const expected = nextFireAfter(input.schedule, lastOkDate);
  if (!expected) return { outcome: "skipped-manual" };
  const intervalS = intervalSecondsAt(input.schedule, expected) ?? 60;
  const overrideS = parseMissedAfter(input.missedAfter);
  const graceS = overrideS ?? Math.max(2 * intervalS, DEFAULT_GRACE_FLOOR_S);
  // See runWatchdog: liveSince is the effective expected time for misses
  // that predate the daemon's start — one grace window after startup, then
  // a pre-restart fault alerts instead of being muted by every restart.
  const inDownWindow = !!input.liveSince && expected < input.liveSince;
  const effectiveExpected = inDownWindow ? input.liveSince! : expected;
  const deadline = new Date(effectiveExpected.getTime() + graceS * 1000);
  if (input.now < deadline) {
    return {
      outcome: inDownWindow ? "skipped-down-window" : "skipped-on-time",
      expected,
      grace_s: graceS,
    };
  }
  if (
    input.lastMissedFiredAt &&
    new Date(input.lastMissedFiredAt) > lastOkDate
  ) {
    return { outcome: "skipped-already-fired", expected, grace_s: graceS };
  }
  if (!input.adapterConfigured) {
    return { outcome: "skipped-no-adapter", expected, grace_s: graceS };
  }
  return { outcome: "fired", expected, grace_s: graceS };
}
