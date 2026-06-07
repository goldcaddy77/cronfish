// Runner-side alert dispatch. Reads .cronfish.json alerts config, resolves
// the adapter for a job, builds the payload, and fires safely.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InvocationStatus } from "../db.ts";
import type { JobMeta, OnFailure } from "../jobs.ts";
import { buildRegistry } from "./registry.ts";
import { safeNotify, type AlertOutcome } from "./safe.ts";
import type { AlertPayload, AlertStatus, AlertsConfig } from "./types.ts";

export interface ConsumerAlertsConfig {
  alerts?: AlertsConfig;
  ui?: { public_url?: string };
}

export function loadConsumerAlertsConfig(
  consumerRoot: string,
): ConsumerAlertsConfig {
  const path = join(consumerRoot, ".cronfish.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConsumerAlertsConfig;
  } catch {
    return {};
  }
}

export function chooseAdapterName(
  onFailure: OnFailure | undefined,
  cfg: AlertsConfig | undefined,
): string | null {
  const fromJob = onFailure?.notify?.trim();
  if (fromJob) return fromJob === "none" ? null : fromJob;
  const fromFleet = cfg?.on_failure?.notify?.trim();
  if (fromFleet) return fromFleet === "none" ? null : fromFleet;
  return null;
}

export function alertStatusFor(
  invocationStatus: InvocationStatus,
): AlertStatus | null {
  if (invocationStatus === "fail") return "fail";
  if (invocationStatus === "timeout") return "timeout";
  if (invocationStatus === "crashed") return "crashed";
  return null;
}

const LOG_TAIL_LINES = 20;
const LOG_TAIL_MAX_BYTES = 4 * 1024;

export function readLogTail(logPath: string): string {
  try {
    if (!existsSync(logPath)) return "";
    const stat = statSync(logPath);
    const start = Math.max(0, stat.size - 64 * 1024);
    const fd = readFileSync(logPath);
    const slice = fd.subarray(start).toString("utf-8");
    const lines = slice.split(/\r?\n/);
    if (lines.length === 0) return "";
    // Drop the partial first line if we sliced mid-file.
    const trimmed = start > 0 ? lines.slice(1) : lines;
    const tail = trimmed.slice(-LOG_TAIL_LINES).join("\n");
    if (Buffer.byteLength(tail, "utf-8") <= LOG_TAIL_MAX_BYTES) return tail;
    // Truncate from the front (keep tail end) until under the cap.
    let lo = 0;
    let hi = tail.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const candidate = tail.slice(mid);
      if (Buffer.byteLength(candidate, "utf-8") <= LOG_TAIL_MAX_BYTES) hi = mid;
      else lo = mid + 1;
    }
    return tail.slice(lo);
  } catch {
    return "";
  }
}

export function buildUiUrl(
  cfg: ConsumerAlertsConfig,
  invocationId: number,
): string | null {
  const base = cfg.ui?.public_url?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/runs/${invocationId}`;
}

export interface DispatchInput {
  job: JobMeta;
  invocationId: number;
  invocationStatus: InvocationStatus;
  alertStatus: AlertStatus; // override for `recovered` / `test`
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  logPath: string;
  consumerRoot: string;
}

export type DispatchOutcome =
  | { kind: "skipped" }
  | { kind: "sent" }
  | { kind: "error"; error: string };

export async function dispatchAlert(
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const cfg = loadConsumerAlertsConfig(input.consumerRoot);
  const adapterName = chooseAdapterName(input.job.on_failure, cfg.alerts);
  if (!adapterName) return { kind: "skipped" };
  const registry = buildRegistry(cfg.alerts);
  if (!registry.has(adapterName)) {
    // Unknown adapter — treat as an error outcome (configuration bug).
    const msg = `unknown adapter "${adapterName}"`;
    console.error(`[cronfish] alert dispatch: ${msg}`);
    return { kind: "error", error: msg };
  }
  const payload: AlertPayload = {
    slug: input.job.slug,
    status: input.alertStatus,
    exit_code: input.exitCode,
    duration_ms: input.durationMs,
    started_at: input.startedAt,
    log_tail: readLogTail(input.logPath),
    ui_url: buildUiUrl(cfg, input.invocationId),
  };
  const outcome: AlertOutcome = await safeNotify(
    registry.get(adapterName),
    payload,
  );
  if (outcome.status === "sent") return { kind: "sent" };
  return { kind: "error", error: outcome.error ?? "unknown error" };
}
