/**
 * Recurring jobs (the cron layer).
 *
 * Declared here, registered by the worker at boot. `upsertJobScheduler` is
 * idempotent and keyed by id, so redeploying does not accumulate duplicate
 * schedules — the classic "the nightly job now runs six times" bug.
 *
 * EVERY PATTERN IS UTC, pinned with `tz: "UTC"` rather than inherited from
 * whatever timezone the worker's host or container happens to run in. Nothing
 * here means "7:30 in the morning" for a person. When something must happen at
 * a tenant's LOCAL time (a morning digest), do not add a schedule per tenant:
 * add ONE system job on a short UTC interval (e.g. every 15 minutes) whose
 * handler fans out, asking each tenant's own timezone whether its local moment
 * has arrived, and enqueues an org-scoped job for those where it has. That stays
 * correct across DST changes and for tenants in different zones, and the
 * per-tenant runs land in `job_run` owned by their tenant.
 */
import { queue } from "./queue";
import type { JobName } from "./handlers";

export interface Schedule {
  /** Stable id — changing it creates a NEW schedule; keep it forever. */
  id: string;
  job: JobName;
  /** Standard 5-field cron, evaluated in UTC (see the header). */
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
  {
    // A short UTC tick, per the header: the job itself decides whether a
    // digest time (NOTIFY_DIGEST_TIMES, local to APP_TIMEZONE) has arrived.
    id: "operator-digest",
    job: "operator.digest",
    pattern: "*/15 * * * *",
    data: {},
  },
];

export async function registerSchedules(): Promise<void> {
  for (const s of SCHEDULES) {
    await queue.upsertJobScheduler(
      s.id,
      { pattern: s.pattern, tz: "UTC" },
      { name: s.job, data: s.data ?? {} },
    );
    console.log(`[jobs] schedule ${s.id} → ${s.job} @ "${s.pattern}" UTC`);
  }
}
