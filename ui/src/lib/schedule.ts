// Render a schedule string as a human-readable phrase.
//
// We accept the same forms cronfish does:
//   - "manual"         → "manual"
//   - "every Ns" / "60s" / "every 5 minutes" → echoed as-is (already human)
//   - bare number      → "every Ns"
//   - 5-field cron     → translated, with each field constrained to "*" or
//                        a single integer (the only form cronfish installs).
//
// Anything we can't confidently translate falls back to the raw string.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isStar(s: string): boolean {
  return s === "*";
}

function isInt(s: string): boolean {
  return /^\d+$/.test(s);
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtTime(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

function translateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hr, dom, mon, dow] = parts;
  if (![min, hr, dom, mon, dow].every((p) => isStar(p) || isInt(p))) {
    return null;
  }

  // every minute
  if (isStar(min) && isStar(hr) && isStar(dom) && isStar(mon) && isStar(dow)) {
    return "every minute";
  }
  // every hour at :MM
  if (isInt(min) && isStar(hr) && isStar(dom) && isStar(mon) && isStar(dow)) {
    return `hourly at :${pad(parseInt(min, 10))}`;
  }
  // daily at HH:MM
  if (isInt(min) && isInt(hr) && isStar(dom) && isStar(mon) && isStar(dow)) {
    return `daily at ${fmtTime(parseInt(hr, 10), parseInt(min, 10))}`;
  }
  // weekly on DOW at HH:MM
  if (isInt(min) && isInt(hr) && isStar(dom) && isStar(mon) && isInt(dow)) {
    const day = DOW[parseInt(dow, 10)] ?? `dow=${dow}`;
    return `${day} at ${fmtTime(parseInt(hr, 10), parseInt(min, 10))}`;
  }
  // monthly on day D at HH:MM
  if (isInt(min) && isInt(hr) && isInt(dom) && isStar(mon) && isStar(dow)) {
    return `day ${parseInt(dom, 10)} at ${fmtTime(parseInt(hr, 10), parseInt(min, 10))}`;
  }
  // yearly on MON DOM at HH:MM
  if (isInt(min) && isInt(hr) && isInt(dom) && isInt(mon) && isStar(dow)) {
    const m = MON[parseInt(mon, 10) - 1] ?? `mon=${mon}`;
    return `${m} ${parseInt(dom, 10)} at ${fmtTime(parseInt(hr, 10), parseInt(min, 10))}`;
  }
  return null;
}

export function humanSchedule(raw: string): string {
  const s = raw.trim();
  if (s === "manual") return "manual";
  if (/^\d+$/.test(s)) return `every ${s}s`;
  // 5-field cron — translate if possible
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s)) {
    return translateCron(s) ?? s;
  }
  return s;
}
