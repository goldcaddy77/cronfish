// Model resolution + provider dispatch for cronfish MD jobs.
//
// Anthropic models are run via the `claude` CLI in headless mode.
// Local models are stubbed — the dispatch seam exists; real wiring waits
// on the user picking a runtime.

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

// Stub: route to a local model. Returns the command to spawn + stdin payload.
export function localCommand(
  modelId: string,
  _prompt: string,
): { cmd: string[]; stdin: string } {
  throw new Error(
    `local:${modelId} not wired — edit src/models.ts in cronfish to add a runtime`,
  );
}
