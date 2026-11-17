import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { LlmProviderError } from "../errors";
import { parseModel } from "../models";
import { setLlmEnv } from "../test-env";
import {
  buildParams,
  buildToolParams,
  callAnthropic,
  callAnthropicTools,
  FALLBACK_BETA,
  toProviderError,
  type AnthropicLike,
} from "./anthropic";
import type { ProviderRequest, ToolTurnRequest } from "./types";

beforeEach(() => setLlmEnv({ ANTHROPIC_API_KEY: "test" }));

const req = (
  model: string,
  extra: Partial<ProviderRequest> = {},
): ProviderRequest => ({
  route: parseModel(`anthropic/${model}`),
  prompt: "hi",
  maxOutputTokens: 1000,
  effort: "medium",
  ...extra,
});

type Msg = Anthropic.Beta.Messages.BetaMessage;
function message(
  over: Partial<Omit<Msg, "usage">> & { usage?: Partial<Msg["usage"]> } = {},
): Msg {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Paris", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    ...over,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
      ...over.usage,
    },
  } as Msg;
}

function fakeClient(msg: Msg | Error) {
  const calls: unknown[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            finalMessage: () =>
              msg instanceof Error ? Promise.reject(msg) : Promise.resolve(msg),
          };
        },
      },
    },
  };
  return { client, calls };
}

describe("buildParams", () => {
  it("never sends sampling params or a thinking config; sets effort explicitly; turns on fallbacks", () => {
    const p = buildParams(
      req("claude-opus-5-5", { system: "be brief" }),
    ) as Record<string, unknown>;
    for (const banned of [
      "temperature",
      "top_p",
      "top_k",
      "thinking",
      "tool_choice",
    ]) {
      expect(p).not.toHaveProperty(banned);
    }
    expect(p).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      system: "be brief",
      output_config: { effort: "medium" },
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
  });

  it("sends no fallbacks for Haiku (it has none) and no effort to models that reject it", () => {
    const haiku = buildParams(req("claude-haiku-5-5")) as Record<
      string,
      unknown
    >;
    expect(haiku).not.toHaveProperty("fallbacks");
    expect(haiku).toMatchObject({ output_config: { effort: "medium" } });
    expect(buildParams(req("claude-haiku-4-5"))).not.toHaveProperty(
      "output_config",
    );
  });

  it("puts a JSON schema in output_config.format (structured output, not forced tool_choice)", () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    expect(
      buildParams(req("claude-sonnet-5-5", { jsonSchema: schema })),
    ).toMatchObject({
      output_config: { format: { type: "json_schema", schema } },
    });
  });
});

describe("callAnthropic", () => {
  it("returns text, usage incl. cache tokens, and the cost at list price", async () => {
    const { client } = fakeClient(
      message({
        usage: {
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    const r = await callAnthropic(req("claude-opus-5-5"), client);
    expect(r).toMatchObject({
      text: "Paris",
      stop: "end",
      servedBy: "anthropic/claude-opus-5-5",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 1_000_000,
      },
    });
    // 1000*4 + 100*20 + 1M*0.2, per million
    expect(r.costUsd).toBeCloseTo(0.206, 6);
  });

  it("surfaces a refusal with its stop_details category", async () => {
    const { client } = fakeClient(
      message({
        stop_reason: "refusal",
        content: [],
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "nope",
        } as Msg["stop_details"],
      }),
    );
    const r = await callAnthropic(req("claude-opus-5-5"), client);
    expect(r.stop).toBe("refusal");
    expect(r.refusal).toEqual({ category: "cyber", explanation: "nope" });
  });

  it("surfaces max_tokens as a truncation", async () => {
    const { client } = fakeClient(message({ stop_reason: "max_tokens" }));
    expect((await callAnthropic(req("claude-opus-5-5"), client)).stop).toBe(
      "max_tokens",
    );
  });

  it("prices a fallback-served turn per hop, and reports who served it", async () => {
    const hop = (type: string, model?: string) => ({
      type,
      ...(model ? { model } : {}),
      input_tokens: 1e6,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const { client } = fakeClient(
      message({
        model: "claude-sonnet-5-5",
        usage: {
          iterations: [
            hop("message"),
            hop("fallback_message", "claude-sonnet-5-5"),
          ] as unknown as Msg["usage"]["iterations"],
        },
      }),
    );
    const r = await callAnthropic(req("claude-opus-5-5"), client);
    expect(r.servedBy).toBe("anthropic/claude-sonnet-5-5");
    expect(r.costUsd).toBe(6); // $4 declined hop + $2 rescue

    // A fallback model with no sourced price makes the whole cost unknown.
    const unknown = fakeClient(
      message({
        usage: {
          iterations: [
            hop("message"),
            hop("fallback_message", "claude-opus-4-8"),
          ] as unknown as Msg["usage"]["iterations"],
        },
      }),
    );
    expect(
      (await callAnthropic(req("claude-opus-5-5"), unknown.client)).costUsd,
    ).toBeNull();
  });
});

describe("toProviderError", () => {
  const headers = new Headers();
  it("marks 429/5xx/connection errors retryable and 400/401 not — by class, not message", () => {
    expect(
      toProviderError(
        new Anthropic.RateLimitError(429, {}, "slow down", headers),
      ).retryable,
    ).toBe(true);
    expect(
      toProviderError(
        new Anthropic.InternalServerError(529, {}, "overloaded", headers),
      ).retryable,
    ).toBe(true);
    expect(
      toProviderError(new Anthropic.APIConnectionError({ message: "reset" }))
        .retryable,
    ).toBe(true);
    expect(
      toProviderError(new Anthropic.BadRequestError(400, {}, "bad", headers))
        .retryable,
    ).toBe(false);
    expect(
      toProviderError(
        new Anthropic.AuthenticationError(401, {}, "key", headers),
      ).retryable,
    ).toBe(false);
  });

  it("is what callAnthropic throws", async () => {
    const { client } = fakeClient(
      new Anthropic.RateLimitError(429, {}, "slow", new Headers()),
    );
    await expect(
      callAnthropic(req("claude-opus-5-5"), client),
    ).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("tool use", () => {
  const turn = (
    model: string,
    extra: Partial<ToolTurnRequest> = {},
  ): ToolTurnRequest => ({
    route: parseModel(`anthropic/${model}`),
    system: "agent",
    transcript: [{ role: "user", text: "tidy my list" }],
    tools: [
      {
        name: "items_search",
        description: "Search items",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    maxOutputTokens: 4000,
    effort: "low",
    ...extra,
  });

  it("sends tools with auto choice: no tool_choice, no thinking, no sampling; explicit effort; fallbacks", () => {
    const p = buildToolParams(turn("claude-opus-5-5")) as Record<
      string,
      unknown
    >;
    for (const banned of [
      "tool_choice",
      "thinking",
      "temperature",
      "top_p",
      "top_k",
    ]) {
      expect(p).not.toHaveProperty(banned);
    }
    expect(p).toMatchObject({
      output_config: { effort: "low" },
      tools: [{ name: "items_search", input_schema: { type: "object" } }],
      fallbacks: "default",
      betas: [FALLBACK_BETA],
    });
  });

  it("returns the assistant's own content unchanged and all of a turn's results in ONE user message", () => {
    const native = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "items_search", input: {} },
      { type: "tool_use", id: "t2", name: "items_search", input: { q: "x" } },
    ];
    const p = buildToolParams(
      turn("claude-opus-5-5", {
        transcript: [
          { role: "user", text: "go" },
          { role: "assistant", text: "", toolCalls: [], native },
          {
            role: "tool",
            results: [
              { id: "t1", name: "items_search", content: "[]" },
              { id: "t2", name: "items_search", content: "bad", isError: true },
            ],
          },
        ],
      }),
    );
    expect(p.messages[1]).toEqual({ role: "assistant", content: native });
    expect(p.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "[]" },
        {
          type: "tool_result",
          tool_use_id: "t2",
          content: "bad",
          is_error: true,
        },
      ],
    });
  });

  it("maps tool_use, pause_turn and refusal stops and extracts the calls", async () => {
    const toolMsg = message({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Looking", citations: null },
        { type: "tool_use", id: "t1", name: "items_search", input: { q: "a" } },
      ] as Msg["content"],
    });
    const r = await callAnthropicTools(
      turn("claude-opus-5-5"),
      fakeClient(toolMsg).client,
    );
    expect(r).toMatchObject({
      stop: "tool_use",
      text: "Looking",
      toolCalls: [{ id: "t1", name: "items_search", input: { q: "a" } }],
      assistant: { native: toolMsg.content },
    });

    const paused = await callAnthropicTools(
      turn("claude-opus-5-5"),
      fakeClient(message({ stop_reason: "pause_turn" })).client,
    );
    expect(paused.stop).toBe("pause");

    const refused = await callAnthropicTools(
      turn("claude-opus-5-5"),
      fakeClient(
        message({
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            category: "cyber",
            explanation: null,
          },
        } as Partial<Msg>),
      ).client,
    );
    expect(refused).toMatchObject({
      stop: "refusal",
      refusal: { category: "cyber" },
    });
  });
});
