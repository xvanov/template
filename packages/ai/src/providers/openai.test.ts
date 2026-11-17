/**
 * OpenAI-family providers, through the real AI SDK with `fetch` stubbed — so
 * these assert the actual wire request (URL, auth header, token field), which
 * is where Azure breaks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LlmProviderError } from "../errors";
import { parseModel } from "../models";
import { setLlmEnv } from "../test-env";
import { callOpenAiFamily, embedOpenAiFamily } from "./openai";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(reply: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

const completion = (content: string, finish = "stop") => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: finish,
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  },
});

const req = (model: string, extra = {}) => ({
  route: parseModel(model),
  prompt: "hi",
  maxOutputTokens: 500,
  effort: "medium" as const,
  ...extra,
});

beforeEach(() =>
  setLlmEnv({
    AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com/",
    AZURE_OPENAI_API_KEY: "az-key",
    OPENAI_API_KEY: "oa-key",
    LLM_BASE_URL: "http://localhost:11434/v1",
  }),
);
afterEach(() => vi.unstubAllGlobals());

describe("azure/", () => {
  it("sends max_completion_tokens (not max_tokens) to a reasoning deployment, with the api-key header", async () => {
    const sent = stubFetch(completion("hello"));
    const r = await callOpenAiFamily(req("azure/gpt-5"));
    expect(sent[0]!.url).toMatch(
      /^https:\/\/res\.openai\.azure\.com\/openai\/v1\/chat\/completions/,
    );
    expect(sent[0]!.headers["api-key"]).toBe("az-key");
    expect(sent[0]!.body).toMatchObject({
      max_completion_tokens: 500,
      reasoning_effort: "medium",
    });
    expect(sent[0]!.body).not.toHaveProperty("max_tokens");
    expect(r).toMatchObject({
      text: "hello",
      stop: "end",
      servedBy: "azure/gpt-5",
      usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 20 },
    });
  });

  it("uses the deployment-scoped URL when a dated api-version is set", async () => {
    setLlmEnv({
      AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_API_VERSION: "2025-04-01-preview",
    });
    const sent = stubFetch(completion("x"));
    await callOpenAiFamily(req("azure/prod-chat"));
    expect(sent[0]!.url).toBe(
      "https://res.openai.azure.com/openai/deployments/prod-chat/chat/completions?api-version=2025-04-01-preview",
    );
  });
});

describe("local/ and stop reasons", () => {
  it("talks to LLM_BASE_URL with max_tokens (what compatible servers read)", async () => {
    const sent = stubFetch(completion("hi"));
    await callOpenAiFamily(req("local/qwen3:32b"));
    expect(sent[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({
      model: "qwen3:32b",
      max_tokens: 500,
    });
  });

  it("maps length to max_tokens and content_filter to refusal", async () => {
    stubFetch(completion("partial", "length"));
    expect((await callOpenAiFamily(req("openai/gpt-4.1"))).stop).toBe(
      "max_tokens",
    );
    stubFetch(completion("", "content_filter"));
    expect((await callOpenAiFamily(req("openai/gpt-4.1"))).stop).toBe(
      "refusal",
    );
  });

  it("hands back raw text (for the caller to reject) when structured output does not parse", async () => {
    const sent = stubFetch(completion("not json"));
    const r = await callOpenAiFamily(
      req("openai/gpt-4.1", {
        jsonSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      }),
    );
    expect(sent[0]!.body).toMatchObject({
      response_format: { type: "json_schema" },
    });
    expect(r.text).toBe("not json");
    expect(r.usage.outputTokens).toBe(20);
  });

  it("wraps HTTP errors in a typed, retry-aware error", async () => {
    stubFetch({ error: { message: "bad key" } }, 401);
    const err = await callOpenAiFamily(req("openai/gpt-4.1")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).retryable).toBe(false);
  });
});

describe("embeddings", () => {
  it("embeds through the same routing and reports tokens", async () => {
    const sent = stubFetch({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
    const r = await embedOpenAiFamily(
      parseModel("openai/text-embedding-3-small"),
      ["hello"],
    );
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect(r).toEqual({ embeddings: [[0.1, 0.2]], tokens: 3 });
  });
});
