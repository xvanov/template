import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — one less
  // build step, and edits are picked up instantly by the dev server.
  transpilePackages: [
    "@repo/ai",
    "@repo/api",
    "@repo/auth",
    "@repo/db",
    "@repo/env",
    "@repo/jobs",
    "@repo/storage",
  ],

  // `standalone` produces the minimal server bundle the Dockerfile copies.
  // The tracing root must be the monorepo root or workspace deps are missed.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),

  // Native / server-only packages must not be bundled.
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "bullmq", "ioredis"],
};

export default nextConfig;
