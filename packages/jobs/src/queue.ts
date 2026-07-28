/**
 * The job queue (producer side).
 *
 * One Redis-backed BullMQ queue carries every job kind, discriminated by job
 * name. One queue keeps concurrency, retries and observability in a single
 * place; split it only when a job kind genuinely needs its own worker pool.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { env } from "@repo/env";

import type { JobName, JobPayloads } from "./handlers";

export const QUEUE_NAME = "app";

/**
 * Both the Redis connection and the queue are built LAZILY, behind a proxy.
 *
 * ioredis dials on construction, so an eager connection would open a socket
 * merely by importing this module — including during `next build`, and in any
 * script that imports something that imports this. Deferring to first use keeps
 * "import" free of side effects.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: with the ioredis default
 * the client throws mid-blocking-command on a reconnect.
 */
let redis: IORedis | undefined;
let queueInstance: Queue | undefined;

function redisInstance(): IORedis {
  return (redis ??= new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  }));
}

function queueInstanceOf(): Queue {
  return (queueInstance ??= new Queue(QUEUE_NAME, {
    connection: redisInstance(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      // Bounded history in Redis; the durable record is the job_run table.
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1_000 },
    },
  }));
}

export const connection: IORedis = new Proxy({} as IORedis, {
  get(_t, prop) {
    const target = redisInstance();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export const queue: Queue = new Proxy({} as Queue, {
  get(_t, prop) {
    const target = queueInstanceOf();
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

/** Type-safe enqueue: the payload must match the job name's schema. */
export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  opts?: { delayMs?: number; jobId?: string; priority?: number },
): Promise<string> {
  const job = await queue.add(name, payload, {
    delay: opts?.delayMs,
    jobId: opts?.jobId,
    priority: opts?.priority,
  });
  return job.id ?? "";
}

export async function closeQueue(): Promise<void> {
  // Only tear down what was actually built — closing a never-created connection
  // would construct one just to shut it down.
  if (queueInstance) await queueInstance.close();
  if (redis) await redis.quit();
}
