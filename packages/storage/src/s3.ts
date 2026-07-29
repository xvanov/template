import { env } from "@repo/env";

import type { PutResult, StorageDriver } from "./types";

/**
 * S3-compatible driver. The AWS SDK is an *optional* dependency and is loaded
 * lazily, so a local-driver deployment never pays for it — and a missing
 * install surfaces as a clear message instead of a module-not-found at boot.
 */
export function s3Driver(): StorageDriver {
  const e = env();
  const bucket = e.S3_BUCKET!;

  const client = async () => {
    const { S3Client } = await load();
    return new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(e.S3_ENDPOINT), // MinIO / R2 style endpoints
      credentials: {
        accessKeyId: e.S3_ACCESS_KEY_ID!,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
      },
    });
  };

  return {
    name: "s3",

    async put(key, body, contentType): Promise<PutResult> {
      const { PutObjectCommand } = await load();
      await (await client()).send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return { key, sizeBytes: body.byteLength };
    },

    async get(key) {
      const { GetObjectCommand } = await load();
      const res = await (await client()).send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`Empty object: ${key}`);
      return new Uint8Array(bytes);
    },

    async delete(key) {
      const { DeleteObjectCommand } = await load();
      await (await client()).send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    },

    async exists(key) {
      const { HeadObjectCommand } = await load();
      try {
        await (await client()).send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return true;
      } catch {
        return false;
      }
    },

    async url(key, expiresInSeconds = 900) {
      const { GetObjectCommand } = await load();
      const { getSignedUrl } = await loadPresigner();
      return getSignedUrl(
        await client(),
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}

async function load() {
  try {
    return await import("@aws-sdk/client-s3");
  } catch {
    throw new Error(
      "STORAGE_DRIVER=s3 requires @aws-sdk/client-s3. Run: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w @repo/storage",
    );
  }
}

async function loadPresigner() {
  try {
    return await import("@aws-sdk/s3-request-presigner");
  } catch {
    throw new Error(
      "STORAGE_DRIVER=s3 requires @aws-sdk/s3-request-presigner. Run: npm i @aws-sdk/s3-request-presigner -w @repo/storage",
    );
  }
}
