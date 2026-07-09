// Bot-token Slack adapter — the API-driveable twin of the webhook `slack`
// adapter. Where `slack` POSTs Block Kit to a per-channel incoming webhook (URL
// bound to one channel at mint time, only creatable via browser OAuth), this
// posts via `chat.postMessage` with a bot token: one credential reaches any
// channel by id/name (with `chat:write.public`, without being invited). Same
// Block Kit body — it reuses `buildSlackBlocks`, so alerts render identically.
//
// Unlike an incoming webhook (which signals failure with a non-2xx status),
// `chat.postMessage` returns HTTP 200 even on logical errors and carries the
// real outcome in the JSON `ok`/`error` fields — so this adapter parses the
// body and throws on `ok:false`, not just on a bad status.

import { buildSlackBlocks } from "./slack.ts";
import type { Adapter, AlertPayload, AlertsConfig } from "./types.ts";

const DEFAULT_TOKEN_ENV = "CRONFISH_SLACK_BOT_TOKEN";
const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export interface SlackBotAdapterOptions {
  botToken?: string;
  channel?: string;
  fetchFn?: typeof fetch;
}

export function createSlackBotAdapter(
  cfg: AlertsConfig["slack_bot"] = {},
  opts: SlackBotAdapterOptions = {},
): Adapter {
  const tokenEnv = cfg.bot_token_env ?? DEFAULT_TOKEN_ENV;
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    name: "slack_bot",
    async notify(payload: AlertPayload): Promise<void> {
      const token = opts.botToken ?? process.env[tokenEnv];
      if (!token) {
        throw new Error(`slack-bot adapter: env var ${tokenEnv} not set`);
      }
      const channel =
        opts.channel ??
        (cfg.channel_env ? process.env[cfg.channel_env] : undefined) ??
        cfg.channel;
      if (!channel) {
        throw new Error(
          "slack-bot adapter: no channel configured " +
            "(set alerts.slack_bot.channel or alerts.slack_bot.channel_env)",
        );
      }
      const blocks = buildSlackBlocks(payload);
      const res = await fetchFn(POST_MESSAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        // `text` is the notification/accessibility fallback Slack shows when
        // blocks can't render (push notifications, screen readers).
        body: JSON.stringify({
          channel,
          text: `${payload.status.toUpperCase()} — ${payload.slug}`,
          blocks,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `slack-bot adapter: chat.postMessage returned ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!data.ok) {
        throw new Error(
          `slack-bot adapter: chat.postMessage failed: ${data.error ?? "unknown error"}`,
        );
      }
    },
  };
}
