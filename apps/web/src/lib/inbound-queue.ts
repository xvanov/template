/**
 * After a webhook stored an inbound message: hand it to the worker.
 *
 * Never fails the webhook. If Redis is unreachable the row is already stored
 * as "received", and the operator tick (`operator.digest`, every 15 minutes)
 * re-queues anything left in that state; answering the provider with an
 * error would only make it retry into a duplicate we already handle.
 */
import type { IntakeResult } from "@repo/inbound";
import { enqueue } from "@repo/jobs";

export async function queueInbound(result: IntakeResult): Promise<void> {
  if (result.outcome === "unrouted" || !result.needsProcessing) return;
  try {
    // Bounded: the queue's Redis client waits for a connection rather than
    // failing, and a provider must get its answer in seconds.
    await Promise.race([
      enqueue(
        "inbound.process",
        { organizationId: result.organizationId, inboundMessageId: result.id },
        // One job per message, even when a provider retry arrives while it is queued.
        { jobId: `inbound-${result.id}` },
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("queue timeout (3s)")), 3000).unref(),
      ),
    ]);
  } catch (err) {
    console.error(
      `[inbound] stored ${result.id} but could not queue it (the 15-minute sweep will):`,
      err,
    );
  }
}

/** The log line for a message that matched no tenant (it is not stored). */
export function logUnrouted(channel: string, to: readonly string[]): void {
  console.warn(
    `[inbound] ${channel} to ${to.slice(0, 3).join(", ").slice(0, 200)} matched no tenant (no inbound_route): dropped`,
  );
}
