/**
 * Recurring jobs (the cron layer).
 *
 * Declared here, registered by the worker at boot. `upsertJobScheduler` is
 * idempotent and keyed by id, so redeploying does not accumulate duplicate
 * schedules — the classic "the nightly job now runs six times" bug.
 */
import { queue } from "./queue";
import type { JobName } from "./handlers";

export interface Schedule {
  /** Stable id — changing it creates a NEW schedule; keep it forever. */
  id: string;
  job: JobName;
  /** Standard 5-field cron, evaluated in the container's timezone (UTC). */
  pattern: string;
  data?: Record<string, unknown>;
}

export const SCHEDULES: Schedule[] = [
  {
    id: "nightly-maintenance",
    job: "maintenance.nightly",
    pattern: "17 3 * * *",
    data: {},
  },
];

export async function registerSchedules(): Promise<void> {
  for (const s of SCHEDULES) {
    await queue.upsertJobScheduler(
      s.id,
      { pattern: s.pattern },
      { name: s.job, data: s.data ?? {} },
    );
    console.log(`[jobs] schedule ${s.id} → ${s.job} @ "${s.pattern}"`);
  }
}
