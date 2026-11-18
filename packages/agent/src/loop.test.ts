/**
 * The loop against a SCRIPTED model: each turn's reply is written out in
 * advance, so these run offline and assert exactly what the loop does with
 * each kind of reply. No database: the recorder is an array, and the tools
 * are test doubles (the real ones run against Postgres in
 * packages/api/test/agent.int.test.ts).
 */
import type { ConverseResult, ToolCall } from "@repo/ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { NotFoundError } from "./errors";
import { classify, runLoop, type Model, type Recorder } from "./loop";
import { prepareProposal } from "./proposals";
import { TOOLS } from "./registry";
import {
  defineReadTool,
  defineWriteTool,
  TOOL_NAME,
  toolSpec,
  type ToolContext,
  type WriteTool,
} from "./tool";

/** One scripted model turn. */
function turn(
  over: Partial<ConverseResult> & { calls?: ToolCall[] } = {},
): ConverseResult {
  const toolCalls = over.calls ?? [];
  const text = over.text ?? "";
  return {
    model: "anthropic/claude-opus-5-5",
    servedBy: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    tier: "default",
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    costUsd: 0.01,
    costKnown: true,
    latencyMs: 1,
    text,
    toolCalls,
    stop: toolCalls.length ? "tool_use" : "end",
    assistant: { role: "assistant", text, toolCalls },
    ...over,
  };
}

/** A model that plays `turns` in order (and fails the test if asked for more). */
function scripted(...turns: (ConverseResult | Error)[]) {
  const seen: Parameters<Model>[0][] = [];
  const model: Model = async (opts) => {
    // Snapshot: the loop keeps appending to the same transcript array.
    seen.push({ ...opts, transcript: [...opts.transcript] });
    const next = turns.shift();
    if (!next) throw new Error("the model was called more times than scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { model, seen };
}

function memoryRecorder(cancelAfter = Infinity) {
  const steps: { kind: string; payload: Record<string, unknown> }[] = [];
  const proposals: { tool: string; input: unknown; summary: string }[] = [];
  let checks = 0;
  const recorder: Recorder = {
    step: async (kind, payload) => void steps.push({ kind, payload }),
    // What createProposal does, minus the database: validate + summarise.
    propose: async (p) => {
      const prepared = await prepareProposal(
        tools.find((t) => t.name === p.tool) as WriteTool,
        ctx,
        p.input,
      );
      proposals.push({
        tool: p.tool,
        input: prepared.input,
        summary: prepared.summary,
      });
      return { id: `prop_${proposals.length}`, summary: prepared.summary };
    },
    cancelled: async () => ++checks > cancelAfter,
  };
  return { recorder, steps, proposals };
}

const search = defineReadTool({
  name: "things_search",
  description: "Search things",
  input: z.object({ q: z.string() }),
  run: vi.fn(async (_ctx: ToolContext, input: { q: string }) => [
    { id: "t1", title: `match for ${input.q}` },
  ]),
});
const apply = vi.fn();
const remove = defineWriteTool({
  name: "things_delete",
  description: "Delete a thing",
  input: z.object({ id: z.string() }),
  summarize: async (_ctx, i) => {
    if (i.id === "missing") throw new NotFoundError("No such thing.");
    return `Delete thing ${i.id}`;
  },
  apply,
});
const tools = [search, remove];
const ctx = { organizationId: "org_1", userId: "u_1" } as ToolContext;

const loop = (model: Model, recorder: Recorder, over = {}) =>
  runLoop({
    goal: "tidy things",
    tools,
    model,
    recorder,
    read: (fn) => fn(ctx),
    maxSteps: 5,
    maxCostUsd: 1,
    ...over,
  });

describe("runLoop", () => {
  it("runs read tools at once, turns write tools into proposals, and ends on the model's answer", async () => {
    const { model, seen } = scripted(
      turn({
        calls: [{ id: "c1", name: "things_search", input: { q: "old" } }],
      }),
      turn({
        calls: [{ id: "c2", name: "things_delete", input: { id: "t1" } }],
      }),
      turn({ text: "Proposed deleting t1." }),
    );
    const mem = memoryRecorder();
    const r = await loop(model, mem.recorder);

    expect(r).toMatchObject({
      stopReason: "done",
      text: "Proposed deleting t1.",
      error: null,
      turns: 3,
      model: "anthropic/claude-opus-5-5",
    });
    expect(r.costUsd).toBeCloseTo(0.03);
    // The write tool NEVER ran: it is a proposal waiting for a person.
    expect(apply).not.toHaveBeenCalled();
    expect(mem.proposals).toEqual([
      {
        tool: "things_delete",
        input: { id: "t1" },
        summary: "Delete thing t1",
      },
    ]);
    expect(mem.steps.map((s) => s.kind)).toEqual([
      "model",
      "tool_call",
      "tool_result",
      "model",
      "tool_call",
      "proposal",
      "tool_result",
      "model",
    ]);
    // The read result reached the model, and it was told the write is queued.
    const third = seen[2]!.transcript;
    expect(third.at(-1)).toMatchObject({
      role: "tool",
      results: [
        {
          id: "c2",
          content: expect.stringMatching(
            /Queued proposal prop_1.*NOT been applied/,
          ),
        },
      ],
    });
    expect(JSON.stringify(seen[1]!.transcript.at(-1))).toContain(
      "match for old",
    );
    // Write tools announce, in their description, that they only propose.
    expect(
      seen[0]!.tools.find((t) => t.name === "things_delete")!.description,
    ).toMatch(/does NOT act/);
  });

  it("answers a bad call with an error result the model can fix, instead of failing the run", async () => {
    const { model, seen } = scripted(
      turn({
        calls: [
          { id: "a", name: "nope", input: {} },
          { id: "b", name: "things_search", input: { q: 42 } },
          { id: "c", name: "things_delete", input: { id: "missing" } },
        ],
      }),
      turn({ text: "Could not." }),
    );
    const mem = memoryRecorder();
    const r = await loop(model, mem.recorder);
    expect(r.stopReason).toBe("done");
    const results = (
      seen[1]!.transcript.at(-1) as {
        results: { content: string; isError: boolean }[];
      }
    ).results;
    expect(results.map((x) => [x.isError, x.content])).toEqual([
      [true, "Unknown tool nope."],
      [true, expect.stringMatching(/^Invalid input: q:/)],
      [true, "No such thing."],
    ]);
    expect(mem.proposals).toEqual([]);
  });

  it("a read tool's typed error goes to the model; an unexpected one is hidden", async () => {
    const broken = defineReadTool({
      name: "broken",
      description: "x",
      input: z.object({}),
      run: async () => {
        throw new Error("SELECT secret FROM somewhere");
      },
    });
    const gone = defineReadTool({
      name: "gone",
      description: "x",
      input: z.object({}),
      run: async () => {
        throw new NotFoundError("That thing is gone.");
      },
    });
    const { model, seen } = scripted(
      turn({
        calls: [
          { id: "a", name: "broken", input: {} },
          { id: "b", name: "gone", input: {} },
        ],
      }),
      turn({ text: "ok" }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await loop(model, memoryRecorder().recorder, { tools: [broken, gone] });
    spy.mockRestore();
    const contents = JSON.stringify(seen[1]!.transcript.at(-1));
    expect(contents).not.toContain("SELECT");
    expect(contents).toContain("failed unexpectedly");
    expect(contents).toContain("That thing is gone.");
  });

  it("stops at max steps and at the per-run spend limit", async () => {
    const forever = () =>
      turn({ calls: [{ id: "c", name: "things_search", input: { q: "x" } }] });
    const a = scripted(forever(), forever(), forever());
    expect(
      await loop(a.model, memoryRecorder().recorder, { maxSteps: 2 }),
    ).toMatchObject({ stopReason: "max_steps", turns: 2 });

    const b = scripted(turn({ ...forever(), costUsd: 0.6 }), forever());
    expect(
      await loop(b.model, memoryRecorder().recorder, { maxCostUsd: 0.5 }),
    ).toMatchObject({ stopReason: "max_cost", turns: 1 });
  });

  it("never runs the tools of a refused or truncated turn", async () => {
    const call = { id: "c", name: "things_delete", input: { id: "t1" } };
    for (const [stop, reason] of [
      ["refusal", "refusal"],
      ["max_tokens", "truncated"],
    ] as const) {
      const { model } = scripted(turn({ calls: [call], stop }));
      const mem = memoryRecorder();
      expect((await loop(model, mem.recorder)).stopReason).toBe(reason);
      expect(mem.proposals).toEqual([]);
    }
  });

  it("sends a paused turn straight back, with no tool results", async () => {
    const { model, seen } = scripted(
      turn({ stop: "pause", text: "thinking" }),
      turn({ text: "done" }),
    );
    expect((await loop(model, memoryRecorder().recorder)).stopReason).toBe(
      "done",
    );
    expect(seen[1]!.transcript.map((e) => e.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("a paused turn counts against the per-run spend limit too", async () => {
    const { model } = scripted(
      turn({ stop: "pause", costUsd: 0.6 }),
      turn({ text: "never reached" }),
    );
    expect(
      await loop(model, memoryRecorder().recorder, { maxCostUsd: 0.5 }),
    ).toMatchObject({ stopReason: "max_cost", turns: 1 });
  });

  it("aborts a model turn that runs past its time limit", async () => {
    let aborted = false;
    const hang: Model = (opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const r = await loop(hang, memoryRecorder().recorder, {
      turnTimeoutMs: 20,
    });
    expect(aborted).toBe(true);
    expect(r).toMatchObject({
      stopReason: "error",
      error: "A model turn took longer than 1s.",
    });
  });

  it("stops when cancelled, before the next turn", async () => {
    const { model } = scripted(
      turn({ calls: [{ id: "c", name: "things_search", input: { q: "x" } }] }),
      turn({ text: "never reached" }),
    );
    const r = await loop(model, memoryRecorder(1).recorder);
    expect(r).toMatchObject({ stopReason: "cancelled", turns: 1 });
  });

  it("maps model errors: AI off and the daily cap are expected states; anything else is hidden", async () => {
    const named = (name: string, message: string) =>
      Object.assign(new Error(message), { name });
    expect(
      classify(
        named("LlmDisabledError", "LLM is switched off (LLM_ENABLED=false)."),
      ),
    ).toEqual({
      stop: "disabled",
      error: "AI is not available: LLM is switched off (LLM_ENABLED=false).",
    });
    expect(
      classify(named("LlmBudgetExceededError", "Daily AI budget")).stop,
    ).toBe("over_budget");
    expect(
      classify(named("LlmProviderError", "anthropic 500: <html>")),
    ).toEqual({
      stop: "error",
      error: "The model call failed (LlmProviderError).",
    });
    const { model } = scripted(named("LlmDisabledError", "off"));
    expect(await loop(model, memoryRecorder().recorder)).toMatchObject({
      stopReason: "disabled",
      turns: 0,
    });
  });
});

describe("the registered tools", () => {
  it("have unique, provider-legal names and a JSON Schema the model can read", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(TOOL_NAME);
      const spec = toolSpec(t);
      expect(spec.inputSchema).toMatchObject({ type: "object" });
      expect(spec.inputSchema).not.toHaveProperty("$schema");
    }
    expect(TOOLS.map((t) => [t.name, t.effect])).toEqual([
      ["items_search", "read"],
      ["docs_search", "read"], // @module:rag
      ["items_create", "write"],
      ["items_delete", "write"],
    ]);
  });
});
