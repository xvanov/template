/**
 * Shared client-side plumbing for BOTH the web and the mobile app: the
 * transformer and the link factory. Keeping this here means the two clients
 * cannot drift apart in ways that only show up as runtime serialization bugs.
 */
import { httpBatchLink, loggerLink, type TRPCLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "./root";

export { superjson as transformer };
export type { AppRouter };

export interface LinkOptions {
  /** Absolute base origin, e.g. `http://192.168.1.20:3200`. */
  baseUrl: string;
  /** Extra headers per request — the mobile client sends its session cookie. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  dev?: boolean;
}

export function createLinks(opts: LinkOptions): TRPCLink<AppRouter>[] {
  return [
    loggerLink({
      enabled: (op) =>
        (opts.dev ?? false) ||
        (op.direction === "down" && op.result instanceof Error),
    }),
    httpBatchLink({
      url: `${opts.baseUrl.replace(/\/$/, "")}/api/trpc`,
      transformer: superjson,
      headers: opts.headers,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          // Session cookie must ride along on cross-origin calls from the phone.
          credentials: "include",
        }),
    }),
  ];
}
