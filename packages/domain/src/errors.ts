/**
 * Typed failures with the SAME NAMES as packages/api/src/errors.ts: the API
 * maps them by `error.name` (NOT_FOUND / BAD_REQUEST), and the agent shows
 * their message to the model. Messages are for people: no internals.
 */
export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class DomainRuleError extends Error {
  override name = "DomainRuleError";
}
