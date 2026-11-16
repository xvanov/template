/**
 * Small, sharp security helpers shared by the web app, the API and the worker.
 *
 *   rateLimit          Redis-backed fixed window (tRPC middleware, route handlers)
 *   verifyBearer /
 *   verifyHmac /
 *   requireCronAuth    machine-to-machine auth; fail closed in production
 *   sealSecret /
 *   openSecret         AES-256-GCM for third-party tokens at rest, key rotation
 *   constantTimeEqual  for comparing anything secret
 */
export { clientIp } from "./client-ip";
export { constantTimeEqual } from "./compare";
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
  type AuthCheck,
  type HmacOptions,
} from "./request-auth";
export {
  keysFromEnv,
  openSecret,
  openSecretDetailed,
  sealSecret,
  sealingConfigured,
  type SealingKeys,
} from "./secrets";
