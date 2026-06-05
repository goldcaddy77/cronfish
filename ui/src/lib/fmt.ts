export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? "" : "in ";
  const suffix = diff >= 0 ? " ago" : "";
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sign}${sec}s${suffix}`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${sign}${min}m${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${sign}${hr}h${suffix}`;
  const day = Math.round(hr / 24);
  return `${sign}${day}d${suffix}`;
}

export function fmtAbsolute(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
