import type { Adapter, AlertPayload } from "./types.ts";

export type AlertOutcomeStatus = "sent" | "error";

export interface AlertOutcome {
  status: AlertOutcomeStatus;
  error: string | null;
}

// Failure-safe wrapper. Adapter throws → swallow, log to stderr, return error
// outcome. Never re-raises. Caller persists outcome to cron_invocations.
export async function safeNotify(
  adapter: Adapter,
  payload: AlertPayload,
): Promise<AlertOutcome> {
  try {
    await adapter.notify(payload);
    return { status: "sent", error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[cronfish] alert adapter "${adapter.name}" failed for ${payload.slug}: ${msg}`,
    );
    return { status: "error", error: msg };
  }
}
