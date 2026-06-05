import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { StatusBadge } from "@/components/StatusBadge";
import { useFetch, type Invocation } from "@/lib/api";
import { fmtAbsolute, fmtDuration } from "@/lib/fmt";

const POLL_MS = 2000;

export function LogViewerPage({ id }: { id: number }): React.ReactElement {
  const inv = useFetch<Invocation>(`/api/invocations/${id}`);
  const [logText, setLogText] = useState<string>("");
  const [logErr, setLogErr] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  const status = inv.data?.status;
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    async function tick(): Promise<void> {
      try {
        const res = await fetch(`/api/invocations/${id}/log`);
        if (!res.ok) throw new Error(`${res.status}`);
        const text = await res.text();
        if (!alive) return;
        setLogText(text);
        setLogErr(null);
        if (followRef.current && preRef.current) {
          preRef.current.scrollTop = preRef.current.scrollHeight;
        }
      } catch (e) {
        if (alive) setLogErr((e as Error).message);
      }
      if (alive && status === "running") {
        timer = window.setTimeout(tick, POLL_MS);
      }
    }
    void tick();
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [id, status]);

  const onScroll = (): void => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    followRef.current = atBottom;
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <header>
        {inv.data?.slug && (
          <Link
            to={`/jobs/${encodeURIComponent(inv.data.slug)}`}
            className="-mt-2 mb-3 inline-block text-xs text-muted-foreground hover:underline"
          >
            ← {inv.data.slug}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl tracking-tight">
            invocation #{id}
          </h1>
          {inv.data && <StatusBadge status={inv.data.status} />}
          {status === "running" && (
            <span className="text-xs text-muted-foreground">
              live · polling every 2s
            </span>
          )}
        </div>
        {inv.data && (
          <p className="mt-1 text-sm text-muted-foreground">
            {fmtAbsolute(inv.data.started_at)} · {inv.data.trigger} ·{" "}
            {fmtDuration(inv.data.duration_ms)}
          </p>
        )}
      </header>

      {logErr && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          log error: {logErr}
        </div>
      )}

      <pre
        ref={preRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90"
      >
        {logText || (
          <span className="text-muted-foreground">(no log output yet)</span>
        )}
      </pre>
    </div>
  );
}
