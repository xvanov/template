/**
 * The background worker process.
 *
 * Runs job handlers from `@repo/jobs` and owns the recurring schedules. It is a
 * SEPARATE process from the web app on purpose: a slow or crashing job must not
 * be able to take request serving down with it.
 */
// MUST be first: populates process.env from the monorepo-root .env before any
// module that reads it is evaluated.
import "@repo/env/load";

import { createWorker, registerSchedules, closeQueue } from "@repo/jobs";
import { env } from "@repo/env";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);

async function main() {
  // Validate the environment before connecting to anything, so a bad config
  // fails in one readable line instead of as a connection timeout.
  env();

  await registerSchedules();

  const worker = createWorker({ concurrency: CONCURRENCY });
  console.log(`[worker] up · concurrency=${CONCURRENCY}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} — draining…`);
    // `close()` waits for in-flight jobs so a deploy cannot sever a job
    // mid-side-effect and leave it to be retried from the top.
    await worker.close();
    await closeQueue();
    console.log("[worker] done");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // An unhandled rejection has already escaped a job's try/catch. Exiting lets
  // the supervisor restart us clean rather than running in an unknown state.
  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandled rejection:", reason);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
