export interface PutResult {
  key: string;
  sizeBytes: number;
}

export interface StorageDriver {
  readonly name: "local" | "s3";
  put(key: string, body: Uint8Array, contentType: string): Promise<PutResult>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * A URL the browser can fetch. For the local driver this is the app's own
   * streaming route; for S3 it is a short-lived presigned URL.
   */
  url(key: string, expiresInSeconds?: number): Promise<string>;
}
