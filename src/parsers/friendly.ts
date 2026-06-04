// Human-string schedule parser, inspired by `friendly-cron` (npm, ISC, v0.0.2)
// but adapted for launchd: `StartCalendarInterval` accepts only single
// integers per field, so we can't express `*/N` calendar intervals. Every
// "every N <unit>" form therefore lowers to a seconds interval — which maps
// directly to launchd `StartInterval`.
//
// Supported inputs:
//   "every second"      → seconds(1)
//   "every minute"      → seconds(60)
//   "every hour"        → seconds(3600)
//   "every N seconds"   → seconds(N)
//   "every N minutes"   → seconds(N*60)
//   "every N hours"     → seconds(N*3600)
//   "every N days"      → seconds(N*86400)
//
// For specific times of day / day-of-week, use the 5-field cron form
// directly (e.g. `schedule: "0 9 * * 1"`).

export type FriendlyResult = { kind: "seconds"; value: number };

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

export function parseFriendly(input: string): FriendlyResult | null {
  const s = input.trim().toLowerCase();
  if (!s.startsWith("every ")) return null;
  const rest = s.slice("every ".length).trim();

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
