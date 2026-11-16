-- AlterTable
ALTER TABLE "job_run" ADD COLUMN     "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "job_run_organizationId_createdAt_idx" ON "job_run"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: attribute existing runs to the tenant named in their payload,
-- read the same way the worker reads it: the TOP-LEVEL "organizationId" string.
-- `payload` is JSON cut at 2000 chars, so a cast can fail; a truncated payload
-- falls back to a key at the very start of the object (where JSON.stringify
-- puts it when the producer wrote it first). Runs whose tenant no longer
-- exists, or never had one, stay NULL = system jobs, invisible to tenants.
CREATE FUNCTION pg_temp.job_run_owner(payload TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  doc JSONB;
BEGIN
  BEGIN
    doc := payload::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN substring(payload FROM '^\{"organizationId":"([^"\\]+)"');
  END;
  IF jsonb_typeof(doc) = 'object' AND jsonb_typeof(doc -> 'organizationId') = 'string' THEN
    RETURN doc ->> 'organizationId';
  END IF;
  RETURN NULL;
END;
$$;

UPDATE "job_run" jr
SET "organizationId" = o.id
FROM "organization" o
WHERE jr.payload IS NOT NULL
  AND o.id = pg_temp.job_run_owner(jr.payload);

DROP FUNCTION pg_temp.job_run_owner(TEXT);
