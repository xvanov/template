-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_message" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blockReason" TEXT,
    "detail" TEXT,
    "providerMessageId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_suppression" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "audit_event_organizationId_createdAt_idx" ON "audit_event"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_targetType_targetId_createdAt_idx" ON "audit_event"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_event_action_createdAt_idx" ON "audit_event"("action", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_message_organizationId_createdAt_idx" ON "outbound_message"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_message_recipient_createdAt_idx" ON "outbound_message"("recipient", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_message_status_createdAt_idx" ON "outbound_message"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_suppression_channel_recipient_idx" ON "outbound_suppression"("channel", "recipient");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_suppression_channel_recipient_organizationId_key" ON "outbound_suppression"("channel", "recipient", "organizationId");

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_message" ADD CONSTRAINT "outbound_message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_suppression" ADD CONSTRAINT "outbound_suppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
