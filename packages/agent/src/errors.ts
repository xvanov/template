/**
 * Typed failures. Same NAMES as packages/api/src/errors.ts, so the API maps
 * them to NOT_FOUND / BAD_REQUEST / CONFLICT with their message (it matches by
 * `error.name`; this package cannot import @repo/api, which imports it).
 * Their messages are shown to the user and to the model: no internals.
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

const EXPECTED = new Set([
  "NotFoundError",
  "DomainRuleError",
  "ConflictError",
  "ForbiddenError",
]);

/** An error whose message was written for a person (safe to show). */
export function isExpected(err: unknown): err is Error {
  return err instanceof Error && EXPECTED.has(err.name);
}
