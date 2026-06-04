// Single-key schedule dispatcher. Accepts every input shape supported by
// `schedule:` and returns either a cron expression (5 fields) or a seconds
// interval. cli.ts maps these to launchd `StartCalendarInterval` /
// `StartInterval` respectively.
//
// Accepted inputs:
//   "M H DOM MON DOW"  → cron       (each field "*" or single integer)
//   "every ..."        → friendly → cron or seconds
//   bare number 60     → seconds    (60)
//   "60s" "5m" "2h" "1d" → seconds
//
// Anything else throws a clear error naming the offending input.

import { parseFriendly } from "./parsers/friendly.ts";

export type Dispatched =
  | { kind: "cron"; expr: string }
  | { kind: "seconds"; value: number };

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function dispatchSchedule(
  input: string | number | undefined,
): Dispatched {
  if (input === undefined || input === null || input === "") {
    throw new Error('schedule: required (cron, "every N units", or seconds)');
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 1) {
      throw new Error(`schedule: bad seconds value ${input}`);
    }
    return { kind: "seconds", value: Math.floor(input) };
  }
  const s = input.trim();
  if (!s) throw new Error("schedule: empty");

  // Shape: "Ns" "Nm" "Nh" "Nd"
  const compact = s.match(/^(\d+)([smhd])$/);
  if (compact) {
    const n = parseInt(compact[1], 10);
    return { kind: "seconds", value: n * UNIT_SECONDS[compact[2]] };
  }

  // Shape: bare integer string
  if (/^\d+$/.test(s)) {
    return { kind: "seconds", value: parseInt(s, 10) };
  }

  // Shape: "every ..."
  if (/^every\b/i.test(s)) {
    const f = parseFriendly(s);
    if (!f) throw new Error(`schedule: unrecognized human form "${input}"`);
    return f;
  }

  // Shape: 5-field cron
  const parts = s.split(/\s+/);
  if (
    parts.length === 5 &&
    parts.every((p) => p === "*" || /^-?\d+$/.test(p))
  ) {
    return { kind: "cron", expr: s };
  }

  throw new Error(
    `schedule: unsupported "${input}" — use cron "M H DOM MON DOW", "every N <unit>", or seconds (60, "5m")`,
  );
}
