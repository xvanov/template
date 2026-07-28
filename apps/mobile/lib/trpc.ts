import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@repo/api";

/**
 * Type-only import: `AppRouter` is erased at build time, so Metro never tries
 * to bundle the server (Prisma, better-auth, BullMQ) into the app. The types
 * are shared; the code is not.
 */
export const trpc = createTRPCReact<AppRouter>();
