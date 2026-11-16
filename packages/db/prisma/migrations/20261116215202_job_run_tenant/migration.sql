-- AlterTable
ALTER TABLE "job_run" ADD COLUMN     "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "job_run_organizationId_createdAt_idx" ON "job_run"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: attribute existing runs to the tenant named in their payload.
-- `payload` is JSON truncated to 2000 chars, so extract with a pattern rather
-- than casting to jsonb (one truncated row would abort the migration). Runs
-- whose tenant no longer exists, or that never had one, stay NULL = system
-- jobs, which tenants no longer see.
UPDATE "job_run" jr
SET "organizationId" = m.org_id
FROM (
  SELECT id, substring(payload FROM '"organizationId":"([^"]+)"') AS org_id
  FROM "job_run"
  WHERE payload IS NOT NULL
) m
WHERE jr.id = m.id
  AND m.org_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM "organization" o WHERE o.id = m.org_id);
