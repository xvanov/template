/**
 * Run a declared schedule NOW, from an external scheduler (a platform cron, a
 * Kubernetes CronJob, an operator with curl):
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
 *     https://app.example.com/api/cron/nightly-maintenance
 *
 * Only ids in SCHEDULES (packages/jobs/src/schedules.ts) can be triggered, with
 * their declared payload: the caller picks WHEN, never what or with which data.
 * The job runs on the worker like any other; this only enqueues it.
 *
 * A route handler, not tRPC: the caller is a machine with a bearer secret,
 * not a signed-in user. `requireCronAuth` fails closed in production when
 * CRON_SECRET is unset.
 */
import { queue, SCHEDULES } from "@repo/jobs";
import { requireCronAuth } from "@repo/security";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ schedule: string }> },
) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  const { schedule } = await params;
  const s = SCHEDULES.find((x) => x.id === schedule);
  if (!s) {
    return Response.json({ error: "Unknown schedule" }, { status: 404 });
  }
  const job = await queue.add(s.job, s.data ?? {});
  return Response.json(
    { schedule: s.id, job: s.job, jobId: job.id },
    { status: 202 },
  );
}
