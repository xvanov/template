/**
 * Small, sharp security helpers shared by the web app, the API and the worker.
 *
 *   rateLimit          Redis-backed fixed window (tRPC middleware, route handlers)
 *   verifyBearer /
 *   verifyHmac /
 *   verifySvix /
 *   requireCronAuth    machine-to-machine auth; fail closed in production
 *   sealSecret /
 *   openSecret         AES-256-GCM for third-party tokens at rest, key rotation
 *   constantTimeEqual  for comparing anything secret
 *   readBodyLimited    a request body with a byte cap (webhooks, before HMAC work)
 *   readBytesLimited   the same, as bytes (file uploads)
 */
export {
  readBodyLimited,
  readBytesLimited,
  type LimitedBody,
  type LimitedBytes,
} from "./body";
export { clientIp } from "./client-ip";
export { constantTimeEqual } from "./compare";
export { closeRequestRedis, requestRedis } from "./redis";
export {
  memoryStore,
  rateLimit,
  redisStore,
  resetTestRateLimits,
  tooManyRequests,
  type CounterStore,
  type RateLimitResult,
} from "./rate-limit";
export {
  authFailure,
  requireCronAuth,
  verifyBearer,
  verifyHmac,
  verifySvix,
  type AuthCheck,
  type HmacOptions,
  type SvixOptions,
} from "./request-auth";
export {
  keysFromEnv,
  openSecret,
  openSecretDetailed,
  sealSecret,
  sealingConfigured,
  type SealingKeys,
} from "./secrets";
