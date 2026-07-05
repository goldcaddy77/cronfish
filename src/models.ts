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
//
// `subconscious/<id>` models route the same way to api.subconscious.dev
// (a hosted Anthropic-compatible endpoint), authenticated with
// SUBCONSCIOUS_API_KEY from the job env.

export type Provider = "anthropic" | "local" | "subconscious";

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
  if (raw.startsWith("subconscious/")) {
    // Subconscious's model namespace includes the prefix (e.g.
    // subconscious/glm-5.2) — pass the id through verbatim.
    return { provider: "subconscious", id: raw };
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
  return backendClaudeEnv(baseUrl, authToken, modelId);
}

// Env block for a `subconscious/*` model — api.subconscious.dev speaks the
// Anthropic Messages API. Requires SUBCONSCIOUS_API_KEY in the job env
// (consumer .env; scope with frontmatter `env: [SUBCONSCIOUS_API_KEY]`).
export function subconsciousClaudeEnv(modelId: string): Record<string, string> {
  const baseUrl = (
    process.env.SUBCONSCIOUS_BASE_URL ?? "https://api.subconscious.dev"
  ).replace(/\/$/, "");
  const authToken = process.env.SUBCONSCIOUS_API_KEY;
  if (!authToken) {
    throw new Error(
      "[models] SUBCONSCIOUS_API_KEY is not set — required for subconscious/* models",
    );
  }
  return backendClaudeEnv(baseUrl, authToken, modelId);
}

// Env block for spawning `claude` against the given provider, or undefined
// for api.anthropic.com models. Single dispatch point for the runner.
export function claudeEnvFor(r: Resolved): Record<string, string> | undefined {
  if (r.provider === "local") return localClaudeEnv(r.id);
  if (r.provider === "subconscious") return subconsciousClaudeEnv(r.id);
  return undefined;
}

function backendClaudeEnv(
  baseUrl: string,
  authToken: string,
  modelId: string,
): Record<string, string> {
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
