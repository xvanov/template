/**
 * Outbound messages: the guard every message passes (email today), and its controls.
 * Channel packages call `deliver`; application code calls the channel package
 * (e.g. `sendMail` from @repo/email), never a provider SDK.
 */
export {
  configFromEnv,
  deliver,
  describeSafeMode,
  type DeliveryResult,
  type GuardDeps,
  type ProviderReceipt,
} from "./guard";
export {
  findSuppression,
  isFrozen,
  setFrozen,
  suppress,
  type FreezeScope,
} from "./controls";
export {
  isLoopbackHost,
  isSafeRecipient,
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
  type SafeMode,
} from "./policy";
