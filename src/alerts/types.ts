// Alert payload + adapter interface. Pure types — no runtime imports.

export type AlertStatus = "fail" | "timeout" | "crashed" | "missed" | "recovered" | "test";

export interface AlertPayload {
  slug: string;
  status: AlertStatus;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: string; // ISO-8601
  log_tail: string;   // last 20 lines, truncated to 4 KB
  ui_url: string | null;
}

export interface Adapter {
  readonly name: string;
  notify(payload: AlertPayload): Promise<void>;
}

export interface AlertsConfig {
  default?: string;
  slack?: {
    webhook_url_env?: string;
  };
  shell?: {
    command?: string;
  };
}
