-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "tags" TEXT[],
    "dedupeKey" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "organizationId" TEXT,
    "digestId" TEXT,
    "outboundMessageId" TEXT,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_dedupeKey_createdAt_idx" ON "notification"("dedupeKey", "createdAt");

-- CreateIndex
CREATE INDEX "notification_status_createdAt_idx" ON "notification"("status", "createdAt");

-- CreateIndex
CREATE INDEX "notification_organizationId_createdAt_idx" ON "notification"("organizationId", "createdAt");
