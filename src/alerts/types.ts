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
  // Default adapter for `cronfish alerts test` (CLI) when no adapter arg is given.
  default?: string;
  // Fleet-wide on_failure default. Per-job frontmatter `on_failure` wins.
  // Per-job `on_failure: { notify: "none" }` opts out of the fleet default.
  on_failure?: {
    notify?: string;
  };
  slack?: {
    webhook_url_env?: string;
  };
  slack_bot?: {
    // Env var holding the bot token (xoxb-…). Default CRONFISH_SLACK_BOT_TOKEN.
    bot_token_env?: string;
    // Target channel — id (C…) or #name. Literal value…
    channel?: string;
    // …or the env var to read it from (takes precedence over `channel`).
    channel_env?: string;
  };
  shell?: {
    command?: string;
  };
}
