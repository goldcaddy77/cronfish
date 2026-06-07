// Single-key schedule dispatcher. Accepts every input shape supported by
// `schedule:` and returns one of:
//   - { kind: "cron", expr }       → launchd StartCalendarInterval
//   - { kind: "seconds", value }   → launchd StartInterval
//   - { kind: "manual" }           → no plist install (job exists, never auto-fires)
//
// Accepted inputs:
//   "M H DOM MON DOW"      → cron (each field "*" or a single integer in range)
//   "every ..."            → human → seconds
//   bare number 60         → seconds
//   "60s" "5m" "2h" "1d"   → seconds
//   "manual"               → manual (no autoschedule)
//
// launchd `StartCalendarInterval` only accepts single ints per field, so we
// never emit `*/N` cron expressions — those become seconds intervals instead.

import { parseFriendly } from "./parsers/friendly.ts";

export type Dispatched =
  | { kind: "cron"; expr: string }
  | { kind: "seconds"; value: number }
  | { kind: "manual" };

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

// Per-field ranges for the standard 5-field cron form.
const CRON_RANGES: { name: string; min: number; max: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function validateCronExpr(expr: string): string {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${parts.length}: "${expr}"`,
    );
  }
  for (let i = 0; i < 5; i++) {
    const p = parts[i];
    const { name, min, max } = CRON_RANGES[i];
    if (p === "*") continue;
    if (!/^\d+$/.test(p)) {
      throw new Error(
        `cron ${name} must be "*" or a non-negative integer, got "${p}"`,
      );
    }
    const n = parseInt(p, 10);
    if (n < min || n > max) {
      throw new Error(`cron ${name} out of range [${min}-${max}]: ${n}`);
    }
  }
  return parts.join(" ");
}

// Next fire time strictly after `from`, in UTC. Returns null for manual or
// unparseable. For our constrained cron form (each field "*" or a single
// integer, no `*/N`) we walk minute-by-minute up to 7 days; that's fine for
// the watchdog's needs and avoids pulling in cronosjs.
export function nextFireAfter(
  schedule: string | number | undefined,
  from: Date,
): Date | null {
  let d: Dispatched;
  try {
    d = dispatchSchedule(schedule);
  } catch {
    return null;
  }
  if (d.kind === "manual") return null;
  if (d.kind === "seconds") {
    return new Date(from.getTime() + d.value * 1000);
  }
  const parts = d.expr.split(/\s+/);
  const [m, h, dom, mon, dow] = parts;
  // Start at the next whole minute boundary strictly after `from`.
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = new Date(from.getTime() + 7 * 86400 * 1000);
  for (let t = start; t <= limit; t = new Date(t.getTime() + 60_000)) {
    if (m !== "*" && t.getUTCMinutes() !== parseInt(m, 10)) continue;
    if (h !== "*" && t.getUTCHours() !== parseInt(h, 10)) continue;
    if (dom !== "*" && t.getUTCDate() !== parseInt(dom, 10)) continue;
    if (mon !== "*" && t.getUTCMonth() + 1 !== parseInt(mon, 10)) continue;
    if (dow !== "*") {
      const want = parseInt(dow, 10) % 7; // 0 == 7 == Sunday
      if (t.getUTCDay() !== want) continue;
    }
    return t;
  }
  return null;
}

// Approximate the configured interval. For seconds schedule this is exact.
// For cron we use (next_after_expected - expected). Returns null when
// indeterminate (manual / unparseable).
export function intervalSecondsAt(
  schedule: string | number | undefined,
  anchor: Date,
): number | null {
  let d: Dispatched;
  try {
    d = dispatchSchedule(schedule);
  } catch {
    return null;
  }
  if (d.kind === "manual") return null;
  if (d.kind === "seconds") return d.value;
  const a = nextFireAfter(schedule, anchor);
  if (!a) return null;
  const b = nextFireAfter(schedule, a);
  if (!b) return null;
  return Math.round((b.getTime() - a.getTime()) / 1000);
}

// Parse a `missed_after:` override. Accepts the same compact units as
// `schedule:` (`30m`, `2h`, `90s`, `1d`, or a bare seconds integer).
// Returns null when not parseable.
export function parseMissedAfter(input: string | number | undefined): number | null {
  if (input === undefined || input === null || input === "") return null;
  try {
    const d = dispatchSchedule(input);
    if (d.kind === "seconds") return d.value;
  } catch {}
  return null;
}

export function dispatchSchedule(
  input: string | number | undefined,
): Dispatched {
  if (input === undefined || input === null || input === "") {
    throw new Error(
      'schedule: required (cron, "every N units", seconds, or "manual")',
    );
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 1) {
      throw new Error(`schedule: seconds value must be >= 1, got ${input}`);
    }
    return { kind: "seconds", value: Math.floor(input) };
  }
  const s = input.trim();
  if (!s) throw new Error("schedule: empty string");

  if (s.toLowerCase() === "manual") return { kind: "manual" };

  const compact = s.match(/^(\d+)([smhd])$/);
  if (compact) {
    const n = parseInt(compact[1], 10);
    if (n < 1) throw new Error(`schedule: ${s} resolves to <1s`);
    return { kind: "seconds", value: n * UNIT_SECONDS[compact[2]] };
  }

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 1)
      throw new Error(`schedule: seconds value must be >= 1, got ${n}`);
    return { kind: "seconds", value: n };
  }

  if (/^every\b/i.test(s)) {
    const f = parseFriendly(s);
    if (!f) {
      throw new Error(
        `schedule: unrecognized human form "${input}" — try "every N seconds|minutes|hours|days"`,
      );
    }
    return f;
  }

  // Cron form — must look like 5 space-separated fields before we try to validate.
  if (/^[\d*\s]+$/.test(s)) {
    return { kind: "cron", expr: validateCronExpr(s) };
  }

  throw new Error(
    `schedule: unsupported "${input}" — use cron "M H DOM MON DOW", "every N <unit>", seconds (60, "5m"), or "manual"`,
  );
}
