import path from "node:path";

import type { NextConfig } from "next";

import { devOriginHosts } from "./src/lib/dev-origins";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source, not build output — one less
  // build step, and edits are picked up instantly by the dev server.
  transpilePackages: [
    "@repo/agent",
    "@repo/ai",
    "@repo/api",
    "@repo/auth",
    "@repo/db",
    "@repo/domain",
    "@repo/email",
    "@repo/env",
    "@repo/jobs",
    "@repo/notify",
    "@repo/outbound",
    "@repo/rag",
    "@repo/security",
    "@repo/storage",
  ],

  // `standalone` produces the minimal server bundle the Dockerfile copies.
  // The tracing root must be the monorepo root or workspace deps are missed.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),

  // Native / server-only packages must not be bundled.
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "bullmq", "ioredis"],

  // Dev-only: let Tailscale/LAN hosts load the dev server's scripts, or pages
  // opened there never hydrate. Read from process.env (not env()) because the
  // config is evaluated before anything validates; the root .env is already
  // loaded by scripts/with-root-env.mjs. Production ignores this setting.
  allowedDevOrigins: devOriginHosts(process.env),

  // Type errors are caught by `make typecheck` (tsc --noEmit, its own gate in
  // CI and the factory). Checking again inside `next build` costs ~7s on every
  // smoke run and Docker build for no extra safety. Never ship without the
  // typecheck gate green.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
