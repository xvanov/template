"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@repo/api";

export const trpc = createTRPCReact<AppRouter>();

/** `RouterOutputs["items"]["list"]` — the type a procedure resolves to. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
