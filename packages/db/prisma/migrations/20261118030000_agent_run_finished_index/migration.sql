-- CreateIndex
CREATE INDEX "agent_run_organizationId_finishedAt_idx" ON "agent_run"("organizationId", "finishedAt");
