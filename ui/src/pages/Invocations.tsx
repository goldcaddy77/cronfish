import { Link } from "wouter";
import { InvocationsTable } from "@/components/InvocationsTable";
import { useFetch, type Invocation, type Job } from "@/lib/api";

export function InvocationsPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const job = useFetch<Job>(`/api/jobs/${encodeURIComponent(slug)}`);
  const invs = useFetch<Invocation[]>(
    `/api/jobs/${encodeURIComponent(slug)}/invocations?limit=100`,
  );

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

      <InvocationsTable
        invocations={invs.data}
        loading={invs.loading}
        error={invs.error}
      />
    </div>
  );
}
