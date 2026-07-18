// Next-occurrence math for the v2 daemon scheduler (docs/v2-daemon.md).
//
// One uniform schedule-change rule, no special cases:
//
//   interval:  next_run = last_run ? max(now, last_run + interval) : now
//   cron:      next occurrence strictly after `now` (croner, DST-correct)
//   manual:    never auto-fires → null
//
// The interval rule absorbs every crossover for free: hourly → every-5-min
// with a stale last run is overdue → fires on the next tick; every-5-min →
// hourly pushes out; cron → interval anchors on the cron era's last run; and
// interval → cron recomputes from now because cron always does. Never-run
// jobs are due immediately (the daemon's first sight of a job runs it).

import { Cron } from "croner";
import { dispatchSchedule } from "./schedule.ts";

// Persisted classification for cron_jobs.schedule_kind. 'once' is reserved
// for one-time jobs (a next_run_at with no recurrence), which have no
// `schedule:` at all — so it never comes out of this function.
export type ScheduleKind = "interval" | "cron" | "once" | "manual";

export function scheduleKind(
  schedule: string | number | undefined,
): Exclude<ScheduleKind, "once"> {
  const d = dispatchSchedule(schedule);
  if (d.kind === "seconds") return "interval";
  return d.kind; // "cron" | "manual"
}

export interface NextRunOptions {
  // Croner timezone override — tests pin this for determinism; production
  // omits it and gets the local tz (the design's contract).
  timezone?: string;
}

// Compute when a job should next fire. Throws on an unparseable schedule
// (same contract as dispatchSchedule); returns null for `manual`.
export function computeNextRun(
  schedule: string | number | undefined,
  lastRun: Date | null,
  now: Date,
  opts?: NextRunOptions,
): Date | null {
  const d = dispatchSchedule(schedule);
  if (d.kind === "manual") return null;
  if (d.kind === "seconds") {
    if (!lastRun) return now;
    const candidate = lastRun.getTime() + d.value * 1000;
    return new Date(Math.max(now.getTime(), candidate));
  }
  // Cron expressions always recompute from now — croner handles DST in the
  // local (or overridden) timezone. nextRun is strictly after `now`.
  const next = new Cron(d.expr, { timezone: opts?.timezone }).nextRun(now);
  if (!next) {
    throw new Error(
      `schedule: cron "${d.expr}" has no future occurrence after ${now.toISOString()}`,
    );
  }
  return next;
}
