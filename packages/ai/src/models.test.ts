import { beforeEach, describe, expect, it } from "vitest";

import { LlmConfigError } from "./errors";
import {
  defaultModel,
  modelForTier,
  parseModel,
  providerConfigured,
  resolve,
  routeEnabled,
} from "./models";
import { setLlmEnv } from "./test-env";

beforeEach(() => setLlmEnv());

describe("parseModel", () => {
  it("splits on the FIRST slash only, so ids may contain slashes", () => {
    expect(parseModel("openrouter/meta-llama/llama-4")).toEqual({
      provider: "openrouter",
      model: "meta-llama/llama-4",
      id: "openrouter/meta-llama/llama-4",
    });
    expect(parseModel("azure/prod-gpt-5").model).toBe("prod-gpt-5");
    expect(parseModel("CLI/claude-opus-5-5").provider).toBe("cli");
  });

  it("treats a bare name as local/ — what LLM_MODEL meant before the router", () => {
    expect(parseModel("gpt-4.1-mini")).toMatchObject({
      provider: "local",
      id: "local/gpt-4.1-mini",
    });
  });

  it("rejects an unknown prefix instead of sending it to LLM_BASE_URL", () => {
    expect(() => parseModel("antropic/claude-opus-5-5")).toThrow(
      LlmConfigError,
    );
    expect(() => parseModel("anthropic/")).toThrow(/no model/);
    expect(() => parseModel("  ")).toThrow(/empty/);
  });
});

describe("defaults and tiers", () => {
  it("defaults to Opus 5.5 when an Anthropic key is present, else the legacy local model", () => {
    expect(defaultModel()).toBe("local/gpt-4.1-mini");
    setLlmEnv({ ANTHROPIC_API_KEY: "k" });
    expect(defaultModel()).toBe("anthropic/claude-opus-5-5");
    setLlmEnv({ ANTHROPIC_API_KEY: "k", LLM_MODEL: "openai/gpt-5" });
    expect(defaultModel()).toBe("openai/gpt-5");
  });

  it("resolves tiers from env and falls back to the default when a tier is unset", () => {
    setLlmEnv({
      LLM_MODEL: "anthropic/claude-sonnet-5-5",
      LLM_MODEL_FAST: "anthropic/claude-haiku-5-5",
    });
    expect(modelForTier("fast")).toBe("anthropic/claude-haiku-5-5");
    expect(modelForTier("smart")).toBe("anthropic/claude-sonnet-5-5");
    expect(resolve({ tier: "fast" }).model).toBe("claude-haiku-5-5");
    // An explicit model beats the tier.
    expect(resolve({ tier: "fast", model: "cli/opus" }).id).toBe("cli/opus");
  });
});

describe("providerConfigured", () => {
  it("needs both key and endpoint for Azure", () => {
    setLlmEnv({ AZURE_OPENAI_API_KEY: "k" });
    expect(providerConfigured("azure")).toBe(false);
    setLlmEnv({
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_ENDPOINT: "https://r.openai.azure.com",
    });
    expect(providerConfigured("azure")).toBe(true);
  });

  it("counts a keyless local server (Ollama) as configured, but not the bare OpenAI default", () => {
    expect(providerConfigured("local")).toBe(false);
    setLlmEnv({ LLM_BASE_URL: "http://localhost:11434/v1" });
    expect(providerConfigured("local")).toBe(true);
  });

  it("is switched off wholesale by LLM_ENABLED=false (the smoke gate)", () => {
    setLlmEnv({ ANTHROPIC_API_KEY: "k", LLM_ENABLED: "false" });
    expect(routeEnabled(parseModel("anthropic/claude-opus-5-5"))).toBe(false);
  });
});
