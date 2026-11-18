/**
 * Typed domain errors. Throw these from resolvers (or from any code a resolver
 * calls) instead of building a `TRPCError` by hand; the `domainErrors`
 * middleware in ./trpc turns each into its tRPC code WITH its message.
 *
 *   NotFoundError       → NOT_FOUND
 *   DomainRuleError     → BAD_REQUEST   (a business rule said no)
 *   ConflictError       → CONFLICT      (already exists / changed underneath)
 *   ForbiddenError      → FORBIDDEN
 *
 * And from @repo/ai (same name-matching, so @repo/api need not import it): // @module:ai
 *   LlmBudgetExceededError → TOO_MANY_REQUESTS   (daily AI cap reached) // @module:ai
 *   LlmDisabledError       → PRECONDITION_FAILED (no provider configured) // @module:ai
 *   LlmUnpricedError       → PRECONDITION_FAILED (capped, model has no price) // @module:ai
 *   LlmConfigError         → PRECONDITION_FAILED (a model string that does not route) // @module:ai
 *   LlmRefusalError        → BAD_REQUEST         (the model declined) // @module:ai
 * // @module:ai
 * LlmProviderError is deliberately NOT mapped: its message carries the // @module:ai
 * upstream response, which stays out of what users see. // @module:ai
 *
 * The message is SHOWN TO THE USER, so write it for them and keep internals
 * (ids of other tenants, SQL, upstream responses) out of it.
 *
 * Matching is by `error.name`, not `instanceof`, so a package that cannot
 * depend on @repo/api (jobs, a service layer) can declare its own class with
 * the same name and get the same mapping. A Prisma unique violation (P2002)
 * becomes CONFLICT with a generic message. Anything else thrown — another
 * Prisma error, a TypeError — stays an opaque INTERNAL_SERVER_ERROR. A
 * TRPCError thrown on purpose is never remapped.
 */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class DomainRuleError extends Error {
  override name = "DomainRuleError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}

export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}

export const DOMAIN_ERROR_CODES = {
  NotFoundError: "NOT_FOUND",
  DomainRuleError: "BAD_REQUEST",
  ConflictError: "CONFLICT",
  ForbiddenError: "FORBIDDEN",
  LlmBudgetExceededError: "TOO_MANY_REQUESTS", // @module:ai
  LlmDisabledError: "PRECONDITION_FAILED", // @module:ai
  LlmUnpricedError: "PRECONDITION_FAILED", // @module:ai
  LlmConfigError: "PRECONDITION_FAILED", // @module:ai
  LlmRefusalError: "BAD_REQUEST", // @module:ai
} as const;

/** The tRPC code for a domain error, or null for anything else. */
export function domainErrorCode(
  err: unknown,
): (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES] | null {
  if (!(err instanceof Error)) return null;
  return Object.hasOwn(DOMAIN_ERROR_CODES, err.name)
    ? DOMAIN_ERROR_CODES[err.name as keyof typeof DOMAIN_ERROR_CODES]
    : null;
}
