/**
 * The worker (consumer side).
 *
 * Every run is written to the `job_run` table — queued → running →
 * completed/failed (or skipped). Redis is ephemeral and BullMQ trims its
 * history, so without this table a job that silently vanished would leave no
 * trace, which is the failure mode you can least afford to be blind to.
 *
 * Each run is owned by a tenant or by nobody (a system job), per the registry
 * entry's `scope`; see `ownerOf`.
 */
import { Worker, type Job } from "bullmq";
import { db, Prisma } from "@repo/db";
import { notifyOperator } from "@repo/notify";

import { handlers, isJobName, type JobName } from "./handlers";
import { connection, QUEUE_NAME } from "./queue";

export interface WorkerOptions {
  concurrency?: number;
}

/** The parts of a BullMQ job the worker reads; lets tests skip Redis. */
export type JobLike = Pick<Job, "id" | "name" | "data" | "attemptsMade">;

/**
 * Has this failure used up the job's retries? Read in BullMQ's "failed" event,
 * where `attemptsMade` already counts the attempt that just failed. An
 * UnrecoverableError is final whatever the count.
 */
export function isFinalFailure(
  job: Pick<Job, "attemptsMade"> & { opts: { attempts?: number } },
  err: Error,
): boolean {
  return (
    err.name === "UnrecoverableError" ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}

/** Returned (not thrown) when a tenant's job outlived its tenant. */
export const SKIPPED_ORG_GONE = { skipped: "organization no longer exists" };

export function createWorker(opts: WorkerOptions = {}): Worker {
  const worker = new Worker(QUEUE_NAME, (job: Job) => processJob(job), {
    connection,
    concurrency: opts.concurrency ?? 5,
    // Locks must outlive the slowest job or BullMQ will re-deliver it while
    // it is still running (duplicate side effects).
    lockDuration: 60_000,
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] ${job?.name} ${job?.id} failed:`, err.message);
    if (job && isFinalFailure(job, err)) {
      void reportFinalFailure(job, err);
      void finalFailureHook(job, err);
    }
  });
  worker.on("completed", (job) => {
    console.log(`[worker] ${job.name} ${job.id} completed`);
  });

  return worker;
}

/**
 * Tell the operator a job gave up. One alert per job NAME per dedupe window: a
 * broken handler failing for every tenant is one problem, not a hundred.
 * Never throws (notifyOperator does not).
 *
 * NO CUSTOMER DATA in alerts (they may sit on a public ntfy server): the job
 * name, its id, the attempt count and the error's class and first line,
 * truncated. The full error is in job_run.
 */
export function reportFinalFailure(job: JobLike, err: Error) {
  const org = (job.data as { organizationId?: unknown } | undefined)
    ?.organizationId;
  const firstLine = (err.message.split("\n").find((l) => l.trim()) ?? "")
    .trim()
    .slice(0, 120);
  return notifyOperator({
    title: `Job ${job.name} failed for good`,
    body: [
      `${err.name}: ${firstLine}`,
      `job ${job.id ?? "?"} · attempt ${job.attemptsMade}${typeof org === "string" ? ` · org ${org}` : ""} · full error in job_run`,
    ].join("\n"),
    priority: "high",
    dedupeKey: `job-failed:${job.name}`,
    organizationId: typeof org === "string" ? org : null,
    tags: ["rotating_light"],
  });
}

/** The job's own onFinalFailure, if it has one. Never throws. */
export async function finalFailureHook(job: JobLike, err: Error) {
  if (!isJobName(job.name)) return;
  const entry = handlers[job.name] as {
    schema: { safeParse: (x: unknown) => { success: boolean; data?: unknown } };
    onFinalFailure?: (p: unknown, e: Error) => Promise<void>;
  };
  if (!entry.onFinalFailure) return;
  const parsed = entry.schema.safeParse(job.data);
  if (!parsed.success) return;
  try {
    await entry.onFinalFailure(parsed.data, err);
  } catch (e) {
    console.error(`[worker] ${job.name} ${job.id} onFinalFailure failed:`, e);
  }
}

/** Validate, record, run, record. Exported so tests can drive it without Redis. */
export async function processJob(job: JobLike): Promise<unknown> {
  if (!isJobName(job.name)) {
    // Fail loudly: a job nobody handles is a deploy-skew bug, not a no-op.
    throw new Error(`Unknown job name: ${job.name}`);
  }
  const entry = handlers[job.name];
  const payload: unknown = entry.schema.parse(job.data);
  const owner = ownerOf(job.name, job.data, payload);

  const run = await startRun(job, owner);
  if (run === ORG_GONE) {
    // Deleted while the job sat in the queue. Running it would act for a
    // tenant that no longer exists, and retrying cannot help.
    console.warn(
      `[worker] ${job.name} ${job.id} skipped: organization ${owner} no longer exists`,
    );
    return SKIPPED_ORG_GONE;
  }
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
}

/**
 * The tenant a run belongs to, or null for a system job.
 *
 * Org jobs: the VALIDATED payload's `organizationId` (the registry's types
 * guarantee it is a string). System jobs: null, and a raw payload that names a
 * tenant is rejected: it is tenant work mislabelled as system, whose runs its
 * tenant could never see.
 */
export function ownerOf(
  name: JobName,
  raw: unknown,
  payload: unknown,
): string | null {
  if (handlers[name].scope === "org") {
    const id = (payload as { organizationId?: unknown }).organizationId;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Org-scoped job ${name} has no organizationId`);
    }
    return id;
  }
  if (raw && typeof raw === "object" && "organizationId" in raw) {
    throw new Error(
      `System job ${name} was given an organizationId; enqueue it as an org-scoped job instead`,
    );
  }
  return null;
}

const ORG_GONE = Symbol("org-gone");

async function startRun(
  job: JobLike,
  organizationId: string | null,
): Promise<string | null | typeof ORG_GONE> {
  const data = {
    jobId: job.id ?? "",
    name: job.name,
    attempts: job.attemptsMade + 1,
    payload: safeJson(job.data),
    startedAt: new Date(),
  };
  try {
    const row = await db.jobRun.create({
      data: { ...data, organizationId, status: "running" },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    if (organizationId && isForeignKeyViolation(err)) {
      // Keep a trace for operators. Unowned, so no tenant sees it.
      await db.jobRun
        .create({
          data: {
            ...data,
            status: "skipped",
            finishedAt: new Date(),
            error: `organization ${organizationId} no longer exists`,
          },
        })
        .catch((e: unknown) =>
          console.error("[worker] could not record skipped job:", e),
        );
      return ORG_GONE;
    }
    // Observability must never be the reason a job does not run.
    console.error("[worker] could not record job start:", err);
    return null;
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003"
  );
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
