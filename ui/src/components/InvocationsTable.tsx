import { useState, Fragment } from "react";
import { Link, useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import type { Invocation } from "@/lib/api";
import { fmtAbsolute, fmtDuration, fmtRelative } from "@/lib/fmt";

// 'catchup' (the coalesced post-downtime run) gets a distinct color so a
// machine that slept through its schedule is visible at a glance.
const TRIGGER_CLS: Record<Invocation["trigger"], string | undefined> = {
  schedule: undefined,
  manual:
    "border-[color-mix(in_oklch,var(--info)_40%,transparent)] bg-[color-mix(in_oklch,var(--info)_12%,transparent)] text-[var(--info)]",
  retry:
    "border-[color-mix(in_oklch,var(--warning)_45%,transparent)] bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]",
  catchup:
    "border-[color-mix(in_oklch,var(--catchup,#9333ea)_40%,transparent)] bg-[color-mix(in_oklch,var(--catchup,#9333ea)_12%,transparent)] text-[var(--catchup,#9333ea)]",
};

function TriggerBadge({
  trigger,
}: {
  trigger: Invocation["trigger"];
}): React.ReactElement {
  return (
    <Badge variant="outline" className={TRIGGER_CLS[trigger]}>
      {trigger}
    </Badge>
  );
}

function OkIndicator({ ok }: { ok: 0 | 1 | null }): React.ReactElement {
  if (ok === 1)
    return (
      <span title="result_ok=true" className="font-mono text-[var(--success)]">
        ✓
      </span>
    );
  if (ok === 0)
    return (
      <span
        title="result_ok=false"
        className="font-mono text-[var(--destructive,#dc2626)]"
      >
        ✗
      </span>
    );
  return <span className="font-mono text-muted-foreground/60">—</span>;
}

function prettyJson(raw: string | null): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface Props {
  invocations: Invocation[] | null;
  loading: boolean;
  error: string | null;
  showJob?: boolean;
}

export function InvocationsTable({
  invocations,
  loading,
  error,
  showJob = false,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [, navigate] = useLocation();

  const cols = showJob ? 8 : 7;

  const toggle = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-6" />
            <TableHead>ID</TableHead>
            {showJob && <TableHead>Job</TableHead>}
            <TableHead>Started</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-8 text-center" title="result_ok">
              OK
            </TableHead>
            <TableHead>Result</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            !invocations &&
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: cols }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {invocations?.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={cols}
                className="py-10 text-center text-muted-foreground"
              >
                No invocations recorded yet.
              </TableCell>
            </TableRow>
          )}
          {invocations?.map((inv) => {
            const isOpen = expanded.has(inv.id);
            const hasJson = inv.result_json !== null;
            return (
              <Fragment key={inv.id}>
                <TableRow
                  onClick={() => toggle(inv.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="text-muted-foreground/60">
                    <span className="font-mono text-xs">
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </TableCell>
                  <TableCell
                    className="font-mono text-xs text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/invocations/${inv.id}`);
                    }}
                  >
                    <span className="hover:underline">#{inv.id}</span>
                  </TableCell>
                  {showJob && inv.slug && (
                    <TableCell
                      className="font-mono text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link
                        to={`/jobs/${encodeURIComponent(inv.slug)}`}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {inv.slug}
                      </Link>
                    </TableCell>
                  )}
                  <TableCell title={fmtAbsolute(inv.started_at)}>
                    {fmtRelative(inv.started_at)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell className="text-center">
                    <OkIndicator ok={inv.result_ok} />
                  </TableCell>
                  <TableCell className="max-w-sm truncate text-sm text-foreground/90">
                    {inv.result_summary ?? (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                    {inv.result_truncated === 1 && (
                      <span
                        title="result may be truncated — sentinel matched a possibly-truncated tail line"
                        className="ms-2 align-middle font-mono text-xs text-[var(--warning,#d97706)]"
                      >
                        ⚠
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {fmtDuration(inv.duration_ms)}
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={cols} className="bg-muted/30 p-0">
                      <div className="space-y-3 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            trigger: <TriggerBadge trigger={inv.trigger} />
                          </span>
                          <span>exit: {inv.exit_code ?? "—"}</span>
                          <Link
                            to={`/invocations/${inv.id}`}
                            className="text-foreground hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            view log →
                          </Link>
                        </div>
                        {inv.result_truncated === 1 && (
                          <div className="rounded border border-[var(--warning,#d97706)]/40 bg-[var(--warning,#d97706)]/10 p-2 text-xs text-[var(--warning,#d97706)]">
                            result may be truncated — the sentinel matched a
                            possibly-truncated tail line.
                          </div>
                        )}
                        {hasJson ? (
                          <pre className="max-h-96 overflow-auto rounded border bg-background p-3 font-mono text-xs leading-relaxed text-foreground/90">
                            {prettyJson(inv.result_json)}
                          </pre>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No structured result for this run.
                          </p>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
