/**
 * Liveness + readiness.
 *
 * `ready` actually touches Postgres and Redis rather than returning a constant
 * — a health check that cannot fail tells you nothing. The smoke gate and the
 * container healthcheck both call it.
 */
import { connection } from "@repo/jobs";
import { llmEnabled } from "@repo/ai"; // @module:ai
import { env } from "@repo/env";

import { createTRPCRouter, publicProcedure } from "../trpc";
import { resolveVersion } from "../version";

export const healthRouter = createTRPCRouter({
  live: publicProcedure.query(() => ({
    ok: true as const,
    version: resolveVersion(),
  })),

  ready: publicProcedure.query(async ({ ctx }) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};

    try {
      await ctx.db.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, error: message(err) };
    }

    try {
      const pong = await connection.ping();
      checks.redis = { ok: pong === "PONG" };
    } catch (err) {
      checks.redis = { ok: false, error: message(err) };
    }

    return {
      ok: Object.values(checks).every((c) => c.ok),
      /** APP_VERSION (the deployed git commit), else package.json's version. */
      version: resolveVersion(),
      checks,
      features: {
        llm: llmEnabled(), // @module:ai
        storage: env().STORAGE_DRIVER,
      },
    };
  }),
});

function message(err: unknown): string {
  return err instanceof Error
    ? err.message.slice(0, 200)
    : String(err).slice(0, 200);
}
