import { describe, expect, test } from "bun:test";
import {
  buildRegistry,
  buildSlackBlocks,
  createShellAdapter,
  createSlackAdapter,
  createSlackBotAdapter,
  payloadEnv,
  safeNotify,
  type Adapter,
  type AlertPayload,
} from "../src/alerts/index.ts";

function payload(overrides: Partial<AlertPayload> = {}): AlertPayload {
  return {
    slug: "test-job",
    status: "fail",
    exit_code: 1,
    duration_ms: 1234,
    started_at: "2026-06-06T00:00:00.000Z",
    log_tail: "line1\nline2",
    ui_url: "https://example.com/run/1",
    ...overrides,
  };
}

describe("payloadEnv", () => {
  test("serializes all fields as strings", () => {
    const env = payloadEnv(payload());
    expect(env.CRONFISH_ALERT_SLUG).toBe("test-job");
    expect(env.CRONFISH_ALERT_STATUS).toBe("fail");
    expect(env.CRONFISH_ALERT_EXIT_CODE).toBe("1");
    expect(env.CRONFISH_ALERT_DURATION_MS).toBe("1234");
    expect(env.CRONFISH_ALERT_STARTED_AT).toBe("2026-06-06T00:00:00.000Z");
    expect(env.CRONFISH_ALERT_UI_URL).toBe("https://example.com/run/1");
    expect(env.CRONFISH_ALERT_LOG_TAIL).toBe("line1\nline2");
  });

  test("null exit_code / duration_ms / ui_url → empty string", () => {
    const env = payloadEnv(
      payload({ exit_code: null, duration_ms: null, ui_url: null }),
    );
    expect(env.CRONFISH_ALERT_EXIT_CODE).toBe("");
    expect(env.CRONFISH_ALERT_DURATION_MS).toBe("");
    expect(env.CRONFISH_ALERT_UI_URL).toBe("");
  });
});

describe("buildSlackBlocks", () => {
  test("header + context + log + button for fail", () => {
    const blocks = buildSlackBlocks(payload()) as Array<{ type: string }>;
    expect(blocks[0]!.type).toBe("header");
    expect(blocks[1]!.type).toBe("context");
    expect(blocks[2]!.type).toBe("section");
    expect(blocks[3]!.type).toBe("actions");
    const header = blocks[0] as { text: { text: string } };
    expect(header.text.text).toContain("FAIL");
    expect(header.text.text).toContain("test-job");
  });

  test("omits log section when log_tail is empty", () => {
    const blocks = buildSlackBlocks(payload({ log_tail: "" })) as Array<{
      type: string;
    }>;
    expect(blocks.find((b) => b.type === "section")).toBeUndefined();
  });

  test("omits actions block when ui_url is null", () => {
    const blocks = buildSlackBlocks(payload({ ui_url: null })) as Array<{
      type: string;
    }>;
    expect(blocks.find((b) => b.type === "actions")).toBeUndefined();
  });

  test("recovered uses green emoji", () => {
    const blocks = buildSlackBlocks(payload({ status: "recovered" })) as Array<{
      type: string;
      text?: { text: string };
    }>;
    expect(blocks[0]!.text!.text).toContain("RECOVERED");
    expect(blocks[0]!.text!.text).toContain(":large_green_circle:");
  });
});

describe("slack adapter", () => {
  test("posts JSON to webhook URL", async () => {
    let captured: { url: string; body: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, body: init.body as string };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createSlackAdapter(
      { webhook_url_env: "TEST_SLACK_WEBHOOK_X" },
      { webhookUrl: "https://hooks.example/slack/xyz", fetchFn: fakeFetch },
    );
    await adapter.notify(payload());
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://hooks.example/slack/xyz");
    const parsed = JSON.parse(captured!.body) as { blocks: unknown[] };
    expect(Array.isArray(parsed.blocks)).toBe(true);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  test("throws when webhook env var is not set", async () => {
    const envName = "CRONFISH_TEST_MISSING_WEBHOOK_" + Math.random().toString(36).slice(2);
    delete process.env[envName];
    const adapter = createSlackAdapter({ webhook_url_env: envName });
    await expect(adapter.notify(payload())).rejects.toThrow(envName);
  });

  test("throws when webhook returns non-2xx", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      {},
      { webhookUrl: "https://hooks.example/x", fetchFn: fakeFetch },
    );
    await expect(adapter.notify(payload())).rejects.toThrow("500");
  });
});

describe("slack_bot adapter", () => {
  function okFetch(capture: (url: string, init: RequestInit) => void) {
    return (async (url: string, init: RequestInit) => {
      capture(url, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("posts to chat.postMessage with bearer auth + channel", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const adapter = createSlackBotAdapter(
      {},
      {
        botToken: "xoxb-test-123",
        channel: "C0B9QB6PR6C",
        fetchFn: okFetch((url, init) => {
          captured = { url, init };
        }),
      },
    );
    await adapter.notify(payload());
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://slack.com/api/chat.postMessage");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer xoxb-test-123");
    const body = JSON.parse(captured!.init.body as string) as {
      channel: string;
      text: string;
      blocks: unknown[];
    };
    expect(body.channel).toBe("C0B9QB6PR6C");
    expect(body.text).toContain("test-job");
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  test("reads token from bot_token_env and channel from channel_env", async () => {
    const tokenEnv = "CRONFISH_TEST_BOT_TOKEN_" + Math.random().toString(36).slice(2);
    const chanEnv = "CRONFISH_TEST_BOT_CHAN_" + Math.random().toString(36).slice(2);
    process.env[tokenEnv] = "xoxb-env-tok";
    process.env[chanEnv] = "#alerts";
    let captured: { init: RequestInit } | null = null;
    try {
      const adapter = createSlackBotAdapter(
        { bot_token_env: tokenEnv, channel_env: chanEnv },
        { fetchFn: okFetch((_url, init) => {
          captured = { init };
        }) },
      );
      await adapter.notify(payload());
    } finally {
      delete process.env[tokenEnv];
      delete process.env[chanEnv];
    }
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer xoxb-env-tok");
    const body = JSON.parse(captured!.init.body as string) as { channel: string };
    expect(body.channel).toBe("#alerts");
  });

  test("throws when bot token env var is not set", async () => {
    const envName = "CRONFISH_TEST_MISSING_BOT_" + Math.random().toString(36).slice(2);
    delete process.env[envName];
    const adapter = createSlackBotAdapter({ bot_token_env: envName, channel: "C1" });
    await expect(adapter.notify(payload())).rejects.toThrow(envName);
  });

  test("throws when no channel is configured", async () => {
    const adapter = createSlackBotAdapter({}, { botToken: "xoxb-x" });
    await expect(adapter.notify(payload())).rejects.toThrow("no channel");
  });

  test("throws on ok:false even with HTTP 200", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const adapter = createSlackBotAdapter(
      {},
      { botToken: "xoxb-x", channel: "C1", fetchFn: fakeFetch },
    );
    await expect(adapter.notify(payload())).rejects.toThrow("channel_not_found");
  });
});

describe("shell adapter", () => {
  test("passes env vars + JSON stdin to command", async () => {
    let captured:
      | { command: string; env: Record<string, string>; stdin: string }
      | null = null;
    const adapter = createShellAdapter(
      { command: "/bin/true" },
      {
        run: async (command, env, stdin) => {
          captured = { command, env, stdin };
        },
      },
    );
    await adapter.notify(payload());
    expect(captured).not.toBeNull();
    expect(captured!.command).toBe("/bin/true");
    expect(captured!.env.CRONFISH_ALERT_SLUG).toBe("test-job");
    const stdinParsed = JSON.parse(captured!.stdin) as AlertPayload;
    expect(stdinParsed.slug).toBe("test-job");
  });

  test("throws when command not configured", async () => {
    const adapter = createShellAdapter({});
    await expect(adapter.notify(payload())).rejects.toThrow("not configured");
  });
});

describe("buildRegistry", () => {
  test("resolves slack + slack_bot + shell adapters", () => {
    const reg = buildRegistry({
      default: "slack",
      slack: { webhook_url_env: "X" },
      slack_bot: { bot_token_env: "Y", channel: "C1" },
      shell: { command: "/bin/true" },
    });
    expect(reg.get("slack").name).toBe("slack");
    expect(reg.get("slack_bot").name).toBe("slack_bot");
    expect(reg.get("shell").name).toBe("shell");
    expect(reg.has("slack")).toBe(true);
    expect(reg.has("slack_bot")).toBe(true);
    expect(reg.defaultName()).toBe("slack");
  });

  test("throws clear error for unknown adapter", () => {
    const reg = buildRegistry();
    expect(() => reg.get("pushover")).toThrow(/unknown alert adapter "pushover"/);
  });
});

describe("safeNotify", () => {
  test("returns sent on success", async () => {
    const adapter: Adapter = {
      name: "ok",
      notify: async () => {},
    };
    const outcome = await safeNotify(adapter, payload());
    expect(outcome.status).toBe("sent");
    expect(outcome.error).toBeNull();
  });

  test("swallows throws and returns error outcome", async () => {
    const adapter: Adapter = {
      name: "broken",
      notify: async () => {
        throw new Error("boom");
      },
    };
    const originalErr = console.error;
    console.error = () => {};
    try {
      const outcome = await safeNotify(adapter, payload());
      expect(outcome.status).toBe("error");
      expect(outcome.error).toBe("boom");
    } finally {
      console.error = originalErr;
    }
  });
});
