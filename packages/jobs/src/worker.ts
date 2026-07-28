/**
 * The worker (consumer side).
 *
 * Every run is written to the `job_run` table — queued → running →
 * completed/failed. Redis is ephemeral and BullMQ trims its history, so
 * without this table a job that silently vanished would leave no trace, which
 * is the failure mode you can least afford to be blind to.
 */
import { Worker, type Job } from "bullmq";
import { db } from "@repo/db";

import { handlers, isJobName } from "./handlers";
import { connection, QUEUE_NAME } from "./queue";

export interface WorkerOptions {
  concurrency?: number;
}

export function createWorker(opts: WorkerOptions = {}): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (!isJobName(job.name)) {
        // Fail loudly: a job nobody handles is a deploy-skew bug, not a no-op.
        throw new Error(`Unknown job name: ${job.name}`);
      }
      const entry = handlers[job.name];
      const payload = entry.schema.parse(job.data);

      const run = await startRun(job);
      try {
        const result = await (entry.run as (p: unknown) => Promise<unknown>)(
          payload,
        );
        await finishRun(run, "completed");
        return result;
      } catch (err) {
        await finishRun(run, "failed", err);
        throw err;
      }
    },
    {
      connection,
      concurrency: opts.concurrency ?? 5,
      // Locks must outlive the slowest job or BullMQ will re-deliver it while
      // it is still running (duplicate side effects).
      lockDuration: 60_000,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] ${job?.name} ${job?.id} failed:`, err.message);
  });
  worker.on("completed", (job) => {
    console.log(`[worker] ${job.name} ${job.id} completed`);
  });

  return worker;
}

async function startRun(job: Job): Promise<string | null> {
  try {
    const row = await db.jobRun.create({
      data: {
        jobId: job.id ?? "",
        name: job.name,
        status: "running",
        attempts: job.attemptsMade + 1,
        payload: safeJson(job.data),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // Observability must never be the reason a job does not run.
    console.error("[worker] could not record job start:", err);
    return null;
  }
}

async function finishRun(
  id: string | null,
  status: "completed" | "failed",
  err?: unknown,
): Promise<void> {
  if (!id) return;
  try {
    await db.jobRun.update({
      where: { id },
      data: {
        status,
        finishedAt: new Date(),
        error:
          err instanceof Error
            ? err.message.slice(0, 1000)
            : err
              ? String(err).slice(0, 1000)
              : null,
      },
    });
  } catch (updateErr) {
    console.error("[worker] could not record job finish:", updateErr);
  }
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return null;
  }
}
