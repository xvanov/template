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

/**
 * A discretionary call refused BEFORE sending because its model has no known
 * price while a cap is set: a cap that cannot price a call cannot cap it.
 * Fix with LLM_PRICES, or mark the call essential.
 */
export class LlmUnpricedError extends Error {
  constructor(readonly model: string) {
    super(
      `No price is configured for ${model}, so optional AI calls on it are paused while a daily cap is set — add it to LLM_PRICES.`,
    );
    this.name = "LlmUnpricedError";
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
 *
 * `costUnknown`: false only when the provider answered with an error status
 * (nothing was generated, nothing billed). A timeout, a dropped connection or
 * a killed process may have been billed for work we never saw, so the call is
 * recorded with costKnown=false and its pre-send estimate kept against the cap.
 */
export class LlmProviderError extends Error {
  readonly costUnknown: boolean;
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    options?: { cause?: unknown; costUnknown?: boolean },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LlmProviderError";
    this.costUnknown = options?.costUnknown ?? true;
  }
}
