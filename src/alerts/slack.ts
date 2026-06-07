import type { Adapter, AlertPayload, AlertsConfig } from "./types.ts";

const STATUS_EMOJI: Record<AlertPayload["status"], string> = {
  fail: ":red_circle:",
  timeout: ":hourglass:",
  crashed: ":boom:",
  missed: ":zzz:",
  recovered: ":large_green_circle:",
  test: ":test_tube:",
};

const STATUS_LABEL: Record<AlertPayload["status"], string> = {
  fail: "FAIL",
  timeout: "TIMEOUT",
  crashed: "CRASHED",
  missed: "MISSED",
  recovered: "RECOVERED",
  test: "TEST",
};

export function buildSlackBlocks(payload: AlertPayload): unknown[] {
  const emoji = STATUS_EMOJI[payload.status] ?? ":grey_question:";
  const label = STATUS_LABEL[payload.status] ?? payload.status.toUpperCase();
  const ctxParts = [
    `started ${payload.started_at}`,
    payload.duration_ms != null ? `duration ${payload.duration_ms}ms` : null,
    payload.exit_code != null ? `exit ${payload.exit_code}` : null,
  ].filter((s): s is string => s != null);

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${label} — ${payload.slug}` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: ctxParts.join(" · ") }],
    },
  ];

  if (payload.log_tail && payload.log_tail.trim().length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "```\n" + payload.log_tail + "\n```" },
    });
  }

  if (payload.ui_url) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View run" },
          url: payload.ui_url,
        },
      ],
    });
  }

  return blocks;
}

export interface SlackAdapterOptions {
  webhookUrl?: string;
  fetchFn?: typeof fetch;
}

export function createSlackAdapter(
  cfg: AlertsConfig["slack"] = {},
  opts: SlackAdapterOptions = {},
): Adapter {
  const envName = cfg.webhook_url_env ?? "CRONFISH_SLACK_WEBHOOK";
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "slack",
    async notify(payload: AlertPayload): Promise<void> {
      const url = opts.webhookUrl ?? process.env[envName];
      if (!url) {
        throw new Error(
          `slack adapter: env var ${envName} not set`,
        );
      }
      const blocks = buildSlackBlocks(payload);
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `slack adapter: webhook returned ${res.status} ${body.slice(0, 200)}`,
        );
      }
    },
  };
}
