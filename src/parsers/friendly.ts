// Vendored from `friendly-cron` (npm, ISC, v0.0.2, ~23 LOC). Original by Ben Drucker.
// Ported to TypeScript with the same semantics. We only call this for human-string
// inputs that already failed the cron-5-field shape, so the input space is small.
//
// Supports:
//   "every second"        → seconds (1)
//   "every minute"        → cron "* * * * *"
//   "every hour"          → cron "0 * * * *"
//   "every N seconds"     → seconds (N)
//   "every N minutes"     → cron "*/N * * * *"
//   "every N hours"       → cron "0 */N * * *"
//   "every N days"        → cron "0 0 */N * *"

export type FriendlyResult =
  | { kind: "cron"; expr: string }
  | { kind: "seconds"; value: number };

const SINGULAR: Record<string, FriendlyResult> = {
  second: { kind: "seconds", value: 1 },
  minute: { kind: "cron", expr: "* * * * *" },
  hour: { kind: "cron", expr: "0 * * * *" },
};

export function parseFriendly(input: string): FriendlyResult | null {
  const s = input.trim().toLowerCase();
  if (!s.startsWith("every ")) return null;
  const rest = s.slice("every ".length).trim();

  if (SINGULAR[rest]) return SINGULAR[rest];

  const m = rest.match(
    /^(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)$/,
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const unit = m[2].replace(/s$/, "");

  switch (unit) {
    case "second":
      return { kind: "seconds", value: n };
    case "minute":
      return { kind: "cron", expr: `*/${n} * * * *` };
    case "hour":
      return { kind: "cron", expr: `0 */${n} * * *` };
    case "day":
      return { kind: "cron", expr: `0 0 */${n} * *` };
  }
  return null;
}
