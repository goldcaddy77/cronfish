import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  claudeEnvFor,
  localClaudeEnv,
  resolveModel,
  subconsciousClaudeEnv,
} from "../src/models.ts";

const SAVED = {
  key: process.env.SUBCONSCIOUS_API_KEY,
  url: process.env.SUBCONSCIOUS_BASE_URL,
};

beforeEach(() => {
  delete process.env.SUBCONSCIOUS_API_KEY;
  delete process.env.SUBCONSCIOUS_BASE_URL;
});

afterEach(() => {
  if (SAVED.key === undefined) delete process.env.SUBCONSCIOUS_API_KEY;
  else process.env.SUBCONSCIOUS_API_KEY = SAVED.key;
  if (SAVED.url === undefined) delete process.env.SUBCONSCIOUS_BASE_URL;
  else process.env.SUBCONSCIOUS_BASE_URL = SAVED.url;
});

describe("resolveModel", () => {
  test("aliases resolve to anthropic ids", () => {
    expect(resolveModel("haiku")).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5-20251001",
    });
  });

  test("raw ids pass through as anthropic", () => {
    expect(resolveModel("claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
  });

  test("local: prefix strips to bare id", () => {
    expect(resolveModel("local:qwen3:30b")).toEqual({
      provider: "local",
      id: "qwen3:30b",
    });
  });

  test("subconscious/ prefix keeps the id verbatim", () => {
    expect(resolveModel("subconscious/glm-5.2")).toEqual({
      provider: "subconscious",
      id: "subconscious/glm-5.2",
    });
  });

  test("undefined defaults to haiku", () => {
    expect(resolveModel(undefined).provider).toBe("anthropic");
  });
});

describe("subconsciousClaudeEnv", () => {
  test("throws when SUBCONSCIOUS_API_KEY is unset", () => {
    expect(() => subconsciousClaudeEnv("subconscious/glm-5.2")).toThrow(
      "SUBCONSCIOUS_API_KEY",
    );
  });

  test("builds full env block with defaults", () => {
    process.env.SUBCONSCIOUS_API_KEY = "sky_test";
    const env = subconsciousClaudeEnv("subconscious/glm-5.2");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.subconscious.dev");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sky_test");
    expect(env.ANTHROPIC_MODEL).toBe("subconscious/glm-5.2");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("subconscious/glm-5.2");
  });

  test("SUBCONSCIOUS_BASE_URL override wins, trailing slash stripped", () => {
    process.env.SUBCONSCIOUS_API_KEY = "sky_test";
    process.env.SUBCONSCIOUS_BASE_URL = "https://proxy.example.com/";
    expect(
      subconsciousClaudeEnv("subconscious/glm-5.2").ANTHROPIC_BASE_URL,
    ).toBe("https://proxy.example.com");
  });
});

describe("claudeEnvFor", () => {
  test("anthropic → undefined (no env injection)", () => {
    expect(claudeEnvFor(resolveModel("sonnet"))).toBeUndefined();
  });

  test("local → localClaudeEnv block", () => {
    const env = claudeEnvFor(resolveModel("local:qwen3:30b"));
    expect(env).toEqual(localClaudeEnv("qwen3:30b"));
    expect(env?.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
  });

  test("subconscious → subconsciousClaudeEnv block", () => {
    process.env.SUBCONSCIOUS_API_KEY = "sky_test";
    const env = claudeEnvFor(resolveModel("subconscious/glm-5.2"));
    expect(env?.ANTHROPIC_BASE_URL).toBe("https://api.subconscious.dev");
    expect(env?.ANTHROPIC_MODEL).toBe("subconscious/glm-5.2");
  });
});
