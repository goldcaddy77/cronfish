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
import { StatusBadge } from "@/components/StatusBadge";
import { useFetch, type Invocation, type Job } from "@/lib/api";
import { fmtAbsolute, fmtDuration, fmtRelative } from "@/lib/fmt";

export function InvocationsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const job = useFetch<Job>(`/api/jobs/${encodeURIComponent(slug)}`);
  const invs = useFetch<Invocation[]>(
    `/api/jobs/${encodeURIComponent(slug)}/invocations?limit=100`,
  );
  const [, navigate] = useLocation();

  return (
    <div className="space-y-4">
      <header>
        <Link
          to="/"
          className="-mt-2 mb-3 inline-block text-xs text-muted-foreground hover:underline"
        >
          ← all jobs
        </Link>
        <h1 className="font-mono text-2xl tracking-tight">
          {job.data?.filename ?? slug}
        </h1>
        {job.data?.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {job.data.description}
          </p>
        )}
      </header>

      {invs.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {invs.error}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>ID</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Exit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invs.loading &&
            !invs.data &&
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 6 }).map((__, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {invs.data?.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={6}
                className="py-10 text-center text-muted-foreground"
              >
                No invocations recorded yet.
              </TableCell>
            </TableRow>
          )}
          {invs.data?.map((inv) => (
            <TableRow
              key={inv.id}
              onClick={() => navigate(`/invocations/${inv.id}`)}
              className="cursor-pointer"
            >
              <TableCell className="font-mono text-xs text-muted-foreground">
                #{inv.id}
              </TableCell>
              <TableCell title={fmtAbsolute(inv.started_at)}>
                {fmtRelative(inv.started_at)}
              </TableCell>
              <TableCell>
                <StatusBadge status={inv.status} />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {inv.trigger}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                {fmtDuration(inv.duration_ms)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                {inv.exit_code ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
