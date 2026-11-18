/**
 * Runs once when the server boots. Used to say, loudly and up front, what the
 * outbound guard's safe mode will do in this environment (strict, local
 * catcher, or off), rather than on the first email.
 * And which model each AI tier routes to, the spend cap, and any model with // @module:ai
 * no price. // @module:ai
 *
 * NEXT_RUNTIME is Next's own flag (not app config, so not in @repo/env); the
 * guard needs Node, so the Edge runtime skips it.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configFromEnv } = await import("@repo/outbound");
  configFromEnv();
  // @module:ai
  const { announceLlmConfig } = await import("@repo/ai");
  announceLlmConfig();
  // @end
}
