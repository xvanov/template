-- AlterTable
ALTER TABLE "llm_call" ADD COLUMN     "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "costKnown" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "tier" TEXT;
