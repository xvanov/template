/**
 * Queue the `ml.predict` example job for one workspace, by slug:
 *
 *   npm run ml:predict -w worker -- demo-acme
 *
 * The running worker picks it up (`make dev` / `make demo`), spawns
 * `uv run predict` in ml/ and logs `[ml] predict ...`; the Items page lists
 * the run under recent jobs. Needs ML_ENABLED=true and a trained model
 * (cd ml && uv run train). See packages/jobs/src/ml.ts for the bridge.
 */
import "@repo/env/load";

import { db } from "@repo/db";
import { env } from "@repo/env";
import { closeQueue, enqueue } from "@repo/jobs";

async function main() {
  const slug = process.argv[2];
  if (!slug)
    throw new Error("usage: npm run ml:predict -w worker -- <org-slug>");
  if (!env().ML_ENABLED) {
    console.warn("[ml] ML_ENABLED is off: the job will be recorded as skipped");
  }
  const org = await db.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!org) throw new Error(`no organization with slug ${slug}`);
  const jobId = await enqueue("ml.predict", { organizationId: org.id });
  console.log(`[ml] queued ml.predict for ${slug} (job ${jobId})`);
  await closeQueue();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
