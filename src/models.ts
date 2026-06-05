// Model resolution + provider dispatch for cronfish MD jobs.
//
// Anthropic models run via the `claude` CLI in headless mode against
// api.anthropic.com.
//
// Local models also run via the `claude` CLI, but with ANTHROPIC_BASE_URL
// pointed at a local Anthropic-compatible endpoint (Ollama 0.14+ speaks
// Messages natively; LiteLLM proxies it for everything else). The model
// ID after the `local:` prefix is passed verbatim to `--model` and as
// the three slot overrides so sub-agents route locally too.

export type Provider = "anthropic" | "local";

export interface Resolved {
  provider: Provider;
  id: string;
}

const ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

export function resolveModel(input: string | undefined): Resolved {
  const raw = (input ?? "haiku").trim();
  if (raw.startsWith("local:")) {
    return { provider: "local", id: raw.slice("local:".length) };
  }
  if (ALIASES[raw]) return { provider: "anthropic", id: ALIASES[raw] };
  return { provider: "anthropic", id: raw };
}

// Env block to inject when spawning `claude` for a local model.
// Overridable via CRONFISH_LOCAL_BASE_URL / CRONFISH_LOCAL_AUTH_TOKEN
// so the same binary can target Ollama, LiteLLM, LM Studio, or a remote
// box on the LAN without touching cronfish.
export function localClaudeEnv(modelId: string): Record<string, string> {
  const baseUrl =
    process.env.CRONFISH_LOCAL_BASE_URL ?? "http://localhost:11434";
  const authToken = process.env.CRONFISH_LOCAL_AUTH_TOKEN ?? "ollama";
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_API_KEY: authToken,
    ANTHROPIC_MODEL: modelId,
    ANTHROPIC_SMALL_FAST_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    CLAUDE_CODE_SUBAGENT_MODEL: modelId,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}
