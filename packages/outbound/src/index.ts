/**
 * Outbound messages: the guard every message passes (email, push), and its controls.
 * Channel packages call `deliver`; application code calls the channel package
 * (e.g. `sendMail` from @repo/email), never a provider SDK.
 */
export {
  configFromEnv,
  deliver,
  describeSafeMode,
  displayRecipient,
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
  CHANNELS,
  effectiveSafeMode,
  isLoopbackHost,
  isOperatorRecipient,
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
