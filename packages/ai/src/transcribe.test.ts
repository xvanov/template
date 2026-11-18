/**
 * transcribe(): routing, the per-minute price, the cap, and the wire format
 * of /audio/transcriptions. Fake provider and fake fetch: no network.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  createLlm,
  LlmBudgetExceededError,
  LlmConfigError,
  LlmDisabledError,
  LlmProviderError,
  LlmUnpricedError,
  transcribeEnabled,
  type Ledger,
  type LlmCallRow,
  type LlmDeps,
} from "./index";
import { parseModel } from "./models";
import { transcribeOpenAiCompatible } from "./providers/transcribe";
import { setLlmEnv } from "./test-env";

function memoryLedger(spent = 0) {
  const rows: LlmCallRow[] = [];
  const ledger: Ledger = {
    async reserve(row, capped, check) {
      const decision = capped
        ? check(spent)
        : { allowed: true, overCap: false };
      if (!decision.allowed) return { id: null, decision, spentUsd: spent };
      rows.push(row);
      return { id: String(rows.length - 1), decision, spentUsd: spent };
    },
    async settle(id, row) {
      rows[Number(id)] = row;
    },
  };
  return { ledger, rows };
}

function harness(
  answer: Awaited<ReturnType<LlmDeps["transcribe"]>> | Error = {
    text: "Buy milk",
    seconds: 30,
  },
  spent = 0,
) {
  const mem = memoryLedger(spent);
  const asked: Parameters<LlmDeps["transcribe"]>[] = [];
  const llm = createLlm({
    transcribe: async (...args) => {
      asked.push(args);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ledger: mem.ledger,
    capHit: () => undefined,
    warn: () => undefined,
  });
  return { llm, rows: mem.rows, asked };
}

/** ~60 s at the 16 kbit/s the estimate assumes. */
const audio = new Uint8Array(120_000);
const call = {
  purpose: "test.dictate",
  priority: "discretionary" as const,
  organizationId: "org_1",
  audio,
  filename: "note.m4a",
  contentType: "audio/mp4",
};

beforeEach(() =>
  setLlmEnv({
    OPENAI_API_KEY: "k",
    LLM_TRANSCRIBE_MODEL: "openai/gpt-4o-mini-transcribe",
    LLM_TRANSCRIBE_COST_PER_MINUTE: "0.003",
    LLM_DAILY_CAP_USD: "1",
  }),
);

describe("transcribe", () => {
  it("routes to LLM_TRANSCRIBE_MODEL and prices the reported duration per minute", async () => {
    const h = harness({ text: "Buy milk", seconds: 30 });
    const r = await h.llm.transcribe(call);
    expect(r).toMatchObject({
      text: "Buy milk",
      model: "openai/gpt-4o-mini-transcribe",
      seconds: 30,
      costUsd: 0.0015,
      costKnown: true,
    });
    expect(h.asked[0]![0].id).toBe("openai/gpt-4o-mini-transcribe");
    expect(h.asked[0]![1]).toMatchObject({
      filename: "note.m4a",
      contentType: "audio/mp4",
    });
    expect(h.rows).toEqual([
      expect.objectContaining({
        kind: "transcribe",
        ok: true,
        status: "done",
        costUsd: 0.0015,
        costKnown: true,
        organizationId: "org_1",
      }),
    ]);
  });

  it("no duration in the answer: keeps the size-based estimate, marked unknown", async () => {
    const h = harness({ text: "x", seconds: null });
    const r = await h.llm.transcribe(call);
    // 120 000 bytes / 2000 B/s = 60 s = 1 minute.
    expect(r).toMatchObject({ costUsd: 0.003, costKnown: false });
  });

  it("is off, cleanly, with no model configured", async () => {
    setLlmEnv({ OPENAI_API_KEY: "k" });
    expect(transcribeEnabled()).toBe(false);
    await expect(harness().llm.transcribe(call)).rejects.toBeInstanceOf(
      LlmDisabledError,
    );
  });

  it("is off when the provider has no key, or LLM_ENABLED=false", async () => {
    setLlmEnv({ LLM_TRANSCRIBE_MODEL: "openai/whisper-1" });
    expect(transcribeEnabled()).toBe(false);
    await expect(harness().llm.transcribe(call)).rejects.toBeInstanceOf(
      LlmDisabledError,
    );
    setLlmEnv({
      OPENAI_API_KEY: "k",
      LLM_TRANSCRIBE_MODEL: "openai/whisper-1",
      LLM_ENABLED: "false",
    });
    expect(transcribeEnabled()).toBe(false);
  });

  it("refuses providers without a transcription endpoint", async () => {
    setLlmEnv({
      ANTHROPIC_API_KEY: "k",
      LLM_TRANSCRIBE_MODEL: "anthropic/claude-haiku-5-5",
    });
    expect(transcribeEnabled()).toBe(false);
    await expect(harness().llm.transcribe(call)).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });

  it("a local whisper server works with its own base URL and no key", () => {
    setLlmEnv({
      LLM_TRANSCRIBE_MODEL: "local/Systran/faster-whisper-small",
      LLM_TRANSCRIBE_BASE_URL: "http://whisper.lan:8000/v1",
    });
    expect(transcribeEnabled()).toBe(true);
  });

  it("unpriced + a cap: a discretionary dictation is refused before sending", async () => {
    setLlmEnv({
      OPENAI_API_KEY: "k",
      LLM_TRANSCRIBE_MODEL: "openai/whisper-1",
      LLM_DAILY_CAP_USD: "1",
    });
    const h = harness();
    await expect(h.llm.transcribe(call)).rejects.toBeInstanceOf(
      LlmUnpricedError,
    );
    expect(h.asked).toEqual([]);
  });

  it("over the cap: refused before sending", async () => {
    const h = harness(undefined, 0.999);
    await expect(h.llm.transcribe(call)).rejects.toBeInstanceOf(
      LlmBudgetExceededError,
    );
    expect(h.asked).toEqual([]);
  });

  it("a provider failure is recorded (ok=false) and rethrown", async () => {
    const h = harness(
      new LlmProviderError("openai 500: boom", "openai", true, {
        costUnknown: false,
      }),
    );
    await expect(h.llm.transcribe(call)).rejects.toThrow("boom");
    expect(h.rows[0]).toMatchObject({
      kind: "transcribe",
      ok: false,
      status: "done",
      costUsd: 0,
    });
  });
});

describe("transcribeOpenAiCompatible (the wire format)", () => {
  type Seen = { url: string; headers: Record<string, string>; form: FormData };
  const fake = (status: number, json: unknown) => {
    const seen: Seen[] = [];
    const http = async (url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: init.headers as Record<string, string>,
        form: init.body as FormData,
      });
      return new Response(JSON.stringify(json), { status });
    };
    return { http, seen };
  };
  const req = {
    audio: new Uint8Array([1, 2, 3]),
    filename: "note.m4a",
    contentType: "audio/mp4",
    language: "en",
  };

  it("OpenAI: multipart file + model, json format, bearer key; duration from usage", async () => {
    setLlmEnv({ OPENAI_API_KEY: "sk-test" });
    const f = fake(200, {
      text: " Buy milk. ",
      usage: { type: "duration", seconds: 4 },
    });
    const r = await transcribeOpenAiCompatible(
      parseModel("openai/gpt-4o-mini-transcribe"),
      req,
      f.http,
    );
    expect(r).toEqual({ text: "Buy milk.", seconds: 4 });
    const s = f.seen[0]!;
    expect(s.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(s.headers.authorization).toBe("Bearer sk-test");
    expect(s.form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(s.form.get("response_format")).toBe("json");
    expect(s.form.get("language")).toBe("en");
    const file = s.form.get("file") as File;
    expect(file.name).toBe("note.m4a");
    expect(file.type).toBe("audio/mp4");
    expect(file.size).toBe(3);
  });

  it("local whisper server: its own base URL, no key, verbose_json for the duration", async () => {
    setLlmEnv({ LLM_TRANSCRIBE_BASE_URL: "http://whisper.lan:8000/v1/" });
    const f = fake(200, { text: "hello", duration: 2.5 });
    const r = await transcribeOpenAiCompatible(
      parseModel("local/Systran/faster-whisper-small"),
      req,
      f.http,
    );
    expect(r).toEqual({ text: "hello", seconds: 2.5 });
    expect(f.seen[0]!.url).toBe(
      "http://whisper.lan:8000/v1/audio/transcriptions",
    );
    expect(f.seen[0]!.headers.authorization).toBeUndefined();
    expect(f.seen[0]!.form.get("model")).toBe("Systran/faster-whisper-small");
    expect(f.seen[0]!.form.get("response_format")).toBe("verbose_json");
  });

  it("an error status is an LlmProviderError with nothing billed", async () => {
    setLlmEnv({ OPENAI_API_KEY: "k" });
    const f = fake(400, { error: { message: "Invalid file format." } });
    const err = await transcribeOpenAiCompatible(
      parseModel("openai/whisper-1"),
      req,
      f.http,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).message).toContain("Invalid file format.");
    expect((err as LlmProviderError).costUnknown).toBe(false);
  });
});
