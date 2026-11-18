-- pgvector. Installed in `public` (the first schema on Prisma's search_path
-- in dev/prod). The test harness pre-installs every extension named like this
-- in `public` before migrating its throwaway schema, which makes this a no-op
-- there (packages/db/testing/schema.ts).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "mediaAssetId" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'text/markdown',
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "indexedHash" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "embeddedCount" INTEGER NOT NULL DEFAULT 0,
    "embeddingModel" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "heading" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1536),
    -- Hand-edited: Prisma cannot express a generated column. The heading
    -- outranks the body (weight A vs B). 'english' stems ("ports" ~ "port");
    -- identifiers like R705 or snake_case stay whole.
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', "heading"), 'A') ||
        setweight(to_tsvector('english', "content"), 'B')
    ) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_organizationId_createdAt_idx" ON "document"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "document_organizationId_mediaAssetId_idx" ON "document"("organizationId", "mediaAssetId");

-- CreateIndex
CREATE INDEX "document_chunk_organizationId_documentId_idx" ON "document_chunk"("organizationId", "documentId");

-- CreateIndex
CREATE INDEX "document_chunk_tsv_idx" ON "document_chunk" USING GIN ("tsv");

-- Hand-written: Prisma has no HNSW index type. Cosine distance (`<=>`),
-- pgvector's default build parameters (m=16, ef_construction=64).
CREATE INDEX "document_chunk_embedding_hnsw_idx" ON "document_chunk" USING hnsw ("embedding" vector_cosine_ops);

-- CreateIndex
CREATE UNIQUE INDEX "document_chunk_documentId_ord_key" ON "document_chunk"("documentId", "ord");

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunk" ADD CONSTRAINT "document_chunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
