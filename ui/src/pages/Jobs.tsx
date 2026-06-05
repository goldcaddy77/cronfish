import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { useFetch, type Job } from "@/lib/api";
import { fmtDuration, fmtRelative } from "@/lib/fmt";
import { humanSchedule } from "@/lib/schedule";

export function JobsPage(): React.ReactElement {
  const { data, loading, error } = useFetch<Job[]>("/api/jobs");
  const [, navigate] = useLocation();

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-heading text-2xl tracking-tight">Jobs</h1>
        <p className="text-sm text-muted-foreground">
          Every cron cronfish has seen, with its most recent run.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>File</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead className="text-right">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            !data &&
            Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 7 }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {data?.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={7}
                className="py-10 text-center text-muted-foreground"
              >
                No jobs yet — run{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  cronfish sync
                </code>
                .
              </TableCell>
            </TableRow>
          )}
          {data?.map((j) => (
            <TableRow
              key={j.slug}
              onClick={() => navigate(`/jobs/${encodeURIComponent(j.slug)}`)}
              className="cursor-pointer"
            >
              <TableCell>
                <span className="font-mono text-sm">{j.filename}</span>
                <span className="ml-2 inline-flex gap-1 align-middle">
                  {!j.enabled && (
                    <Badge
                      variant="secondary"
                      className="text-muted-foreground"
                    >
                      disabled
                    </Badge>
                  )}
                  {j.deleted_at && <Badge variant="outline">deleted</Badge>}
                </span>
              </TableCell>
              <TableCell className="max-w-sm truncate text-muted-foreground">
                {j.description ?? (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                title={j.schedule}
              >
                {humanSchedule(j.schedule)}
              </TableCell>
              <TableCell>
                <StatusBadge status={j.last_status} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {fmtRelative(j.last_started_at)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {j.enabled ? (
                  fmtRelative(j.next_run)
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                {fmtDuration(j.last_duration_ms)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
