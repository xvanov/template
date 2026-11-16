/**
 * Outbound messages: the guard every email/SMS/push passes, and its controls.
 * Channel packages call `deliver`; application code calls the channel package
 * (e.g. `sendMail` from @repo/email), never a provider SDK.
 */
export {
  configFromEnv,
  deliver,
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
  isSafeRecipient,
  normalizeRecipient,
  parseSafeList,
  staticBlock,
  volumeBuckets,
  type Block,
  type BlockReason,
  type Channel,
  type GuardConfig,
  type OutboundAttempt,
} from "./policy";
