import { useEffect, useState } from "react";

export type InvocationStatus =
  | "running"
  | "ok"
  | "fail"
  | "timeout"
  | "crashed";

export type JobState = "active" | "disabled" | "deleted";

export interface Job {
  id: number;
  slug: string;
  kind: "md" | "ts" | "sh" | "py";
  schedule: string;
  enabled: 0 | 1;
  // v2 daemon scheduler fields (null on rows a v2 sync hasn't touched yet).
  state: JobState | null;
  schedule_kind: "interval" | "cron" | "once" | "manual" | null;
  next_run_at: string | null;
  timeout_s: number | null;
  retries: number;
  concurrency: "skip" | "queue";
  model: string | null;
  description: string | null;
  last_synced_at: string;
  deleted_at: string | null;
  filename: string;
  next_run: string | null;
  last_status: InvocationStatus | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_exit_code: number | null;
  last_duration_ms: number | null;
  last_invocation_id: number | null;
}

export interface Invocation {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: InvocationStatus;
  exit_code: number | null;
  trigger: "schedule" | "manual" | "retry" | "catchup";
  duration_ms: number | null;
  slug?: string;
  result_summary: string | null;
  result_ok: 0 | 1 | null;
  result_json: string | null;
  result_truncated: 0 | 1;
}

export interface DaemonStatus {
  live: boolean;
  heartbeat: {
    pid: number;
    started_at: string;
    last_tick_at: string;
    version: string | null;
    tick_count: number;
  } | null;
  now: string;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useFetch<T>(path: string, deps: unknown[] = []): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchJson<T>(path)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, tick, ...deps]);
  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
