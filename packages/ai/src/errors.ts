/**
 * Typed failures. Callers branch on the class, never on a message string.
 *
 * Every error that happens AFTER a provider answered carries the call's
 * `costUsd`: a refused or truncated reply was still billed.
 */

/** No provider is configured for this model (or LLM_ENABLED=false). */
export class LlmDisabledError extends Error {
  constructor(detail?: string) {
    super(
      detail ??
        "LLM is not configured — set LLM_MODEL and its provider's key in .env (see .env.example).",
    );
    this.name = "LlmDisabledError";
  }
}

/** A model string that does not route anywhere: a typo, not a runtime condition. */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** A discretionary call refused BEFORE sending: it would cross the daily cap. */
export class LlmBudgetExceededError extends Error {
  constructor(
    /** null when the spend could not be read (refused because unknown). */
    readonly spentUsd: number | null,
    readonly estimateUsd: number,
    readonly capUsd: number,
  ) {
    super(
      spentUsd === null
        ? "Today's AI spend could not be read, so optional AI calls are paused."
        : `Daily AI budget of $${capUsd} reached for this workspace ` +
            `(spent $${spentUsd.toFixed(4)}, this call ~$${estimateUsd.toFixed(4)}).`,
    );
    this.name = "LlmBudgetExceededError";
  }
}

/** The model declined (Anthropic `stop_reason: "refusal"`, OpenAI content filter). */
export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly explanation: string | null,
    readonly costUsd: number,
  ) {
    super(
      `The model declined${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : "."}`,
    );
    this.name = "LlmRefusalError";
  }
}

/** The reply hit max output tokens. `partialText` is what arrived — never use it as if complete. */
export class LlmTruncatedError extends Error {
  constructor(
    readonly partialText: string,
    readonly costUsd: number,
  ) {
    super("The reply was cut off at the output-token limit.");
    this.name = "LlmTruncatedError";
  }
}

/**
 * The provider failed (HTTP error, timeout, CLI exit). `retryable` is decided
 * from the SDK's typed errors (429/5xx/connection = true; 400/401/404 = false).
 */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmProviderError";
  }
}
