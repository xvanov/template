/**
 * Speech-to-text over the OpenAI-compatible `POST /audio/transcriptions`
 * (multipart: file + model). One wire format, many servers:
 *
 *   openai/gpt-4o-mini-transcribe   api.openai.com (OPENAI_API_KEY, OPENAI_BASE_URL)
 *   openai/whisper-1                same
 *   azure/<deployment>              Azure OpenAI, deployment-scoped URL with
 *                                   AZURE_OPENAI_API_VERSION (a dated one;
 *                                   default 2024-10-21) and the api-key header.
 *                                   Azure's v1 surface answers
 *                                   DeploymentNotFound for audio (seen live).
 *   local/<model>                   any compatible server: speaches /
 *                                   faster-whisper-server, LocalAI, a Groq-style
 *                                   API, at LLM_TRANSCRIBE_BASE_URL (else
 *                                   LLM_BASE_URL), key LLM_API_KEY if set
 *
 * A plain fetch, not the AI SDK: the compatible provider the rest of the
 * package uses for local/ has no transcription model, and this is one call.
 */
import { env } from "@repo/env";

import { LlmConfigError, LlmProviderError } from "../errors";
import type { ProviderId, Route } from "../models";

export const TRANSCRIBE_PROVIDERS: ProviderId[] = ["openai", "azure", "local"];

export interface TranscribeRequest {
  audio: Uint8Array;
  filename: string;
  contentType: string;
  /** ISO-639-1 hint ("en"); improves accuracy and latency. */
  language?: string;
  /** Vocabulary hint: names, jargon. */
  prompt?: string;
  timeoutMs?: number;
}

export interface TranscribeResponse {
  text: string;
  /** Audio length the server reported, if it did. */
  seconds: number | null;
  /**
   * Token usage, when the model bills by token (gpt-4o-*-transcribe report
   * `usage: { type: "tokens", input_tokens, output_tokens }`). Null otherwise.
   */
  tokens: { input: number; output: number } | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/** Oldest GA Azure api-version with /audio/transcriptions (verified live). */
export const AZURE_TRANSCRIBE_API_VERSION = "2024-10-21";

/** Where a route's transcription goes; null url = not configured. */
export function transcribeEndpoint(route: Route): {
  url: string | null;
  headers: Record<string, string>;
} {
  const e = env();
  const bearer = (key: string | undefined): Record<string, string> =>
    key ? { authorization: `Bearer ${key}` } : {};
  const at = (base: string) =>
    `${base.replace(/\/+$/, "")}/audio/transcriptions`;
  switch (route.provider) {
    case "openai":
      return {
        url: e.OPENAI_API_KEY
          ? at(e.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE)
          : null,
        headers: bearer(e.OPENAI_API_KEY),
      };
    case "azure": {
      if (!e.AZURE_OPENAI_ENDPOINT || !e.AZURE_OPENAI_API_KEY) {
        return { url: null, headers: {} };
      }
      const endpoint = e.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "").replace(
        /\/openai(\/v1)?$/,
        "",
      );
      const version =
        e.AZURE_OPENAI_API_VERSION && e.AZURE_OPENAI_API_VERSION !== "v1"
          ? e.AZURE_OPENAI_API_VERSION
          : AZURE_TRANSCRIBE_API_VERSION;
      return {
        url: `${endpoint}/openai/deployments/${encodeURIComponent(route.model)}/audio/transcriptions?api-version=${encodeURIComponent(version)}`,
        headers: { "api-key": e.AZURE_OPENAI_API_KEY },
      };
    }
    case "local": {
      const base = e.LLM_TRANSCRIBE_BASE_URL ?? e.LLM_BASE_URL;
      // The OpenAI default with no key is "nobody configured this".
      const configured =
        Boolean(e.LLM_TRANSCRIBE_BASE_URL) ||
        Boolean(e.LLM_API_KEY) ||
        base.replace(/\/+$/, "") !== OPENAI_DEFAULT_BASE;
      return {
        url: configured ? at(base) : null,
        headers: bearer(e.LLM_API_KEY || undefined),
      };
    }
    default:
      throw new LlmConfigError(
        `transcription is not wired for ${route.provider}/ — use one of ${TRANSCRIBE_PROVIDERS.join(", ")}`,
      );
  }
}

/**
 * gpt-4o-*-transcribe accept only `json` (which carries `usage`); whisper
 * models and local servers give the audio duration with `verbose_json`.
 */
function responseFormat(route: Route): "json" | "verbose_json" {
  return route.provider === "local" || /whisper/i.test(route.model)
    ? "verbose_json"
    : "json";
}

export async function transcribeOpenAiCompatible(
  route: Route,
  req: TranscribeRequest,
  http: FetchLike = (url, init) => fetch(url, init),
): Promise<TranscribeResponse> {
  const { url, headers } = transcribeEndpoint(route);
  if (!url)
    throw new LlmConfigError(
      `${route.id} is not configured for transcription.`,
    );
  const form = new FormData();
  form.append(
    "file",
    new Blob([req.audio as Uint8Array<ArrayBuffer>], {
      type: req.contentType,
    }),
    req.filename,
  );
  form.append("model", route.model);
  form.append("response_format", responseFormat(route));
  if (req.language) form.append("language", req.language);
  if (req.prompt) form.append("prompt", req.prompt);

  let res: Response;
  try {
    res = await http(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
    });
  } catch (err) {
    // No answer: it may have been billed for audio we never got text for.
    throw new LlmProviderError(
      `${route.provider}: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        300,
      ),
      route.provider,
      true,
      { cause: err, costUnknown: true },
    );
  }
  const json = (await res.json().catch(() => null)) as {
    text?: unknown;
    duration?: unknown;
    usage?: {
      type?: string;
      seconds?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
    };
    error?: { message?: string };
  } | null;
  if (!res.ok || !json || typeof json.text !== "string") {
    throw new LlmProviderError(
      `${route.provider} ${res.status}: ${json?.error?.message ?? res.statusText ?? "no transcript in the response"}`.slice(
        0,
        300,
      ),
      route.provider,
      res.status === 429 || res.status >= 500,
      // An error status = refused, nothing billed.
      { costUnknown: res.ok },
    );
  }
  const seconds =
    typeof json.duration === "number"
      ? json.duration
      : json.usage?.type === "duration" &&
          typeof json.usage.seconds === "number"
        ? json.usage.seconds
        : null;
  const u = json.usage;
  const tokens =
    u?.type === "tokens" &&
    typeof u.input_tokens === "number" &&
    typeof u.output_tokens === "number"
      ? { input: u.input_tokens, output: u.output_tokens }
      : null;
  return { text: json.text.trim(), seconds, tokens };
}
