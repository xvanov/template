/**
 * Outbound messages: the guard every message passes (email, push, sms), and its controls.
 * Channel packages call `deliver`; application code calls the channel package
 * (e.g. `sendMail` from @repo/email), never a provider SDK.
 */
export {
  configFromEnv,
  deliver,
  describeSafeMode,
  displayRecipient,
  IdempotencyConflictError,
  PENDING_STALE_MS,
  type DeliveryResult,
  type GuardDeps,
  type ProviderReceipt,
  type SendMeta,
  type Transport,
} from "./guard";
export {
  DELIVERY_STATUSES,
  deliveryAdvances,
  findSuppression,
  isFrozen,
  recordDeliveryStatus,
  setFrozen,
  suppress,
  unsuppress,
  type FreezeScope,
} from "./controls";
export {
  CHANNELS,
  effectiveSafeMode,
  isLoopbackHost,
  isOperatorRecipient,
  isSafeRecipient,
  maskRecipient,
  parsePhone,
  parseRecipient,
  parseSafeList,
  resolveSafeMode,
  staticBlock,
  volumeBuckets,
  type Block,
  type BlockReason,
  type Channel,
  type GuardConfig,
  type OutboundAttempt,
  type RecipientFacts,
  type SafeMode,
} from "./policy";
