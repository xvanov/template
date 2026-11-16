/**
 * The REQUEST-PATH Redis connection: counters for rate limits and outbound
 * volume caps.
 *
 * Deliberately not the BullMQ connection in packages/jobs. That one must have
 * no command timeout (workers block on BRPOPLPUSH); this one must have a short
 * one, so a Redis outage fails a request in ~2s instead of hanging it.
 *
 * Lazy: importing this module opens no socket (see packages/jobs/queue.ts for
 * why that matters during `next build`).
 */
import IORedis from "ioredis";
import { env } from "@repo/env";

let client: IORedis | undefined;

export function requestRedis(): IORedis {
  return (client ??= new IORedis(env().REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
  }));
}

/** Close the connection (tests, graceful shutdown). */
export async function closeRequestRedis(): Promise<void> {
  const c = client;
  client = undefined;
  await c?.quit();
}
