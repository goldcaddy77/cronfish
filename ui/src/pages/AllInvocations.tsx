import { InvocationsTable } from "@/components/InvocationsTable";
import { useFetch, type Invocation } from "@/lib/api";

export function AllInvocationsPage(): React.ReactElement {
  const invs = useFetch<Invocation[]>("/api/invocations?limit=200");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-heading text-2xl tracking-tight">All runs</h1>
        <p className="text-sm text-muted-foreground">
          Every invocation across every job, newest first.
        </p>
      </header>

      <InvocationsTable
        invocations={invs.data}
        loading={invs.loading}
        error={invs.error}
        showJob
      />
    </div>
  );
}
