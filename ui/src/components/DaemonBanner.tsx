import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { useFetch, type DaemonStatus } from "@/lib/api";
import { fmtRelative } from "@/lib/fmt";

function fmtUptime(startedAt: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

// Header badge when the daemon is live; loud full-width banner when it isn't
// — a dead scheduler means nothing fires, which must not look like "all
// quiet". Polls /api/daemon so a wedge shows up without a page reload.
export function DaemonBanner(): React.ReactElement | null {
  const { data, refresh } = useFetch<DaemonStatus>("/api/daemon");

  useEffect(() => {
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;

  if (data.live && data.heartbeat) {
    const hb = data.heartbeat;
    return (
      <Badge
        variant="outline"
        title={`pid ${hb.pid} · tick #${hb.tick_count} · last tick ${fmtRelative(hb.last_tick_at)}`}
        className="border-[color-mix(in_oklch,var(--success)_40%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]"
      >
        <span className="me-1 inline-block size-1.5 animate-pulse rounded-full bg-current" />
        daemon live · pid {hb.pid}
        {hb.version ? ` · v${hb.version}` : ""} · up{" "}
        {fmtUptime(hb.started_at, data.now)}
      </Badge>
    );
  }

  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
      daemon {data.heartbeat ? "STALE" : "not running"} — scheduled jobs will
      not fire
      {data.heartbeat && (
        <span className="ms-2 font-normal text-destructive/80">
          (pid {data.heartbeat.pid}, last tick{" "}
          {fmtRelative(data.heartbeat.last_tick_at)})
        </span>
      )}
    </div>
  );
}
