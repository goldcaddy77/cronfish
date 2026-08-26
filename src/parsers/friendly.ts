// Human-string schedule parser, inspired by `friendly-cron` (npm, ISC, v0.0.2)
// but adapted for launchd: `StartCalendarInterval` accepts only single
// integers per field, so we can't express `*/N` calendar intervals or ranges.
//
// Two families come out of here:
//
//   Intervals — "every N <unit>" lowers to a seconds interval, which maps
//   directly to launchd `StartInterval`.
//
//     "every second"      → seconds(1)
//     "every minute"      → seconds(60)
//     "every hour"        → seconds(3600)
//     "every N seconds"   → seconds(N)
//     "every N minutes"   → seconds(N*60)
//     "every N hours"     → seconds(N*3600)
//     "every N days"      → seconds(N*86400)
//
//   Calendar times — "at <time>" pins a wall-clock moment, which is a cron
//   expression, NOT an interval. This is the shape people actually reach for
//   ("every day at 07:20") and the shape whose absence caused CAD-1577: it
//   read perfectly, threw at parse time, and the job was skipped in silence.
//
//     "every day at 9"        → cron "0 9 * * *"
//     "every day at 07:20"    → cron "20 7 * * *"
//     "every day at 3pm"      → cron "0 15 * * *"
//     "every monday at 8:30"  → cron "30 8 * * 1"
//     "every hour at :15"     → cron "15 * * * *"
//
// Deliberately NOT supported, because each is ambiguous and a silent wrong
// guess is worse than a loud error:
//
//   "every day"          — interval-from-now, or midnight? Say which:
//                          "every 1 days" or "every day at 0:00".
//   "every morning"      — no defensible hour.
//   "every weekday"      — needs a day-of-week RANGE, which launchd's
//                          StartCalendarInterval cannot express.

export type FriendlyResult =
  | { kind: "seconds"; value: number }
  | { kind: "cron"; expr: string };

const SINGULAR_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
};

const UNIT_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
};

// Sunday-first, matching cron's day-of-week numbering.
const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

// The forms we accept, in the exact words a caller should try instead. Shown
// verbatim in the error a bad human string produces — the error IS the docs.
export const FRIENDLY_FORMS = [
  '"every N seconds|minutes|hours|days" (interval)',
  '"every day at 9" / "every day at 07:20" / "every day at 3pm" (daily)',
  '"every monday at 8:30" (weekly; any day name)',
  '"every hour at :15" (hourly, at that minute past)',
];

/**
 * Parse a wall-clock time of day into {hour, minute}, or null.
 * Accepts: "9", "09", "9:30", "09:05", "9am", "9 am", "3pm", "12:15am".
 */
export function parseTimeOfDay(
  input: string,
): { hour: number; minute: number } | null {
  const m = input
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] === undefined ? 0 : parseInt(m[2], 10);
  const meridiem = m[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

export function parseFriendly(input: string): FriendlyResult | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s.startsWith("every ")) return null;
  const rest = s.slice("every ".length).trim();

  // --- calendar forms: "<period> at <time>" ---
  const at = rest.match(/^(.+?)\s+at\s+(.+)$/);
  if (at) {
    const period = at[1].trim();
    const timeRaw = at[2].trim();

    // "every hour at :15" → minute-past-the-hour.
    if (period === "hour") {
      const mm = timeRaw.match(/^:?(\d{1,2})$/);
      if (!mm) return null;
      const minute = parseInt(mm[1], 10);
      if (minute > 59) return null;
      return { kind: "cron", expr: `${minute} * * * *` };
    }

    const tod = parseTimeOfDay(timeRaw);
    if (!tod) return null;

    if (period === "day") {
      return { kind: "cron", expr: `${tod.minute} ${tod.hour} * * *` };
    }
    const dow = DAY_NAMES[period];
    if (dow !== undefined) {
      return { kind: "cron", expr: `${tod.minute} ${tod.hour} * * ${dow}` };
    }
    return null;
  }

  // --- interval forms: "every [N] <unit>" ---
  if (SINGULAR_SECONDS[rest] !== undefined) {
    return { kind: "seconds", value: SINGULAR_SECONDS[rest] };
  }

  const m = rest.match(
    /^(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$/,
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const unit = m[2].replace(/s$/, "");
  const sec = UNIT_SECONDS[unit];
  if (!sec) return null;
  return { kind: "seconds", value: n * sec };
}
