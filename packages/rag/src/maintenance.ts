/**
 * Keeping `document.status` honest when indexing cannot finish on its own.
 * A document must never sit at "pending"/"indexing" forever: the UI polls
 * it, and a person cannot tell "slow" from "lost".
 *
 *   markIngestFailed   the docs.ingest job failed for good (retries used up)
 *   markQueueFailed    the job could not be queued at all (Redis down)
 *   sweepStaleIngests  safety net: rows left in flight by a lost job (worker
 *                      killed mid-run, queue flushed). Run by the 15-minute
 *                      operator tick, next to the agent-run equivalent.
 * Every one ends in "failed" with a note saying "Re-index", which retries.
 */
import { db } from "@repo/db";

const IN_FLIGHT = ["pending", "indexing"];
/** Older than this and still in flight = lost. Ingest is seconds to minutes. */
export const STALE_INGEST_MS = 60 * 60 * 1000;

const firstLine = (err: unknown) =>
  (err instanceof Error ? err.message : String(err))
    .split("\n")[0]!
    .slice(0, 200);

export async function markIngestFailed(
  job: { organizationId: string; documentId: string },
  err: unknown,
): Promise<void> {
  await db.document.updateMany({
    where: {
      id: job.documentId,
      organizationId: job.organizationId,
      status: { in: IN_FLIGHT },
    },
    data: {
      status: "failed",
      note: `Indexing failed: ${firstLine(err)}. Re-index to retry.`,
    },
  });
}

export async function markQueueFailed(job: {
  organizationId: string;
  documentId: string;
}): Promise<void> {
  await db.document.updateMany({
    where: {
      id: job.documentId,
      organizationId: job.organizationId,
      status: { in: IN_FLIGHT },
    },
    data: {
      status: "failed",
      note: "Indexing could not be queued (background worker unavailable). Re-index to retry.",
    },
  });
}

/** System-wide (all tenants): a maintenance job, never called for a request. */
export async function sweepStaleIngests(now = new Date()): Promise<number> {
  const { count } = await db.document.updateMany({
    where: {
      status: { in: IN_FLIGHT },
      updatedAt: { lt: new Date(now.getTime() - STALE_INGEST_MS) },
    },
    data: {
      status: "failed",
      note: "Indexing never finished (the background job was lost). Re-index to retry.",
    },
  });
  return count;
}
