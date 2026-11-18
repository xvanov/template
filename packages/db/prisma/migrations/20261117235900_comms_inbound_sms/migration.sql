-- AlterTable
ALTER TABLE "media_asset" ALTER COLUMN "uploadedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "outbound_message" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryDetail" TEXT,
ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "idempotencyScope" TEXT;

-- CreateTable
CREATE TABLE "inbound_message" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT,
    "snippet" TEXT,
    "text" TEXT,
    "html" TEXT,
    "messageIdHeader" TEXT,
    "inReplyTo" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "replyToOutboundId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "error" TEXT,
    "raw" JSONB,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_route" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "autoForOrg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_route_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_message_organizationId_createdAt_idx" ON "inbound_message"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "inbound_message_organizationId_handledAt_idx" ON "inbound_message"("organizationId", "handledAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_message_provider_providerMessageId_key" ON "inbound_message"("provider", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_route_autoForOrg_key" ON "inbound_route"("autoForOrg");

-- CreateIndex
CREATE INDEX "inbound_route_organizationId_idx" ON "inbound_route"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_route_channel_address_key" ON "inbound_route"("channel", "address");

-- CreateIndex
CREATE INDEX "outbound_message_channel_providerMessageId_idx" ON "outbound_message"("channel", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_message_idempotencyScope_idempotencyKey_key" ON "outbound_message"("idempotencyScope", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_replyToOutboundId_fkey" FOREIGN KEY ("replyToOutboundId") REFERENCES "outbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_message" ADD CONSTRAINT "inbound_message_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_route" ADD CONSTRAINT "inbound_route_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

