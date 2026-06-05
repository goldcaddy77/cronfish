import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { InvocationStatus } from "@/lib/api";

const STYLE: Record<
  InvocationStatus,
  { variant: "default" | "secondary" | "destructive" | "outline"; cls?: string }
> = {
  running: {
    variant: "outline",
    cls: "border-[color-mix(in_oklch,var(--info)_40%,transparent)] bg-[color-mix(in_oklch,var(--info)_12%,transparent)] text-[var(--info)]",
  },
  ok: {
    variant: "outline",
    cls: "border-[color-mix(in_oklch,var(--success)_40%,transparent)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] text-[var(--success)]",
  },
  fail: { variant: "destructive" },
  timeout: {
    variant: "outline",
    cls: "border-[color-mix(in_oklch,var(--warning)_45%,transparent)] bg-[color-mix(in_oklch,var(--warning)_15%,transparent)] text-[var(--warning)]",
  },
  crashed: { variant: "destructive" },
};

export function StatusBadge({
  status,
}: {
  status: InvocationStatus | null;
}): React.ReactElement {
  if (!status) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        never run
      </Badge>
    );
  }
  const s = STYLE[status];
  return (
    <Badge variant={s.variant} className={cn(s.cls)}>
      {status === "running" && (
        <span className="me-1 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status}
    </Badge>
  );
}
