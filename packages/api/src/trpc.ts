/**
 * tRPC setup — the single API surface, consumed by BOTH the web app and the
 * mobile app with end-to-end type safety.
 *
 * Three procedure builders, in increasing strictness:
 *
 *   publicProcedure     — no session required
 *   protectedProcedure  — a signed-in user
 *   orgProcedure        — a signed-in user acting in a tenant; injects
 *                         `ctx.organizationId`
 *
 * Tenant isolation lives HERE, not in each resolver. If you write a resolver
 * that touches an org-scoped table, use `orgProcedure` and filter on
 * `ctx.organizationId`. Reviewers should reject any org-scoped query that does
 * not.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { auth } from "@repo/auth";
import { db } from "@repo/db";

export interface CreateContextOptions {
  headers: Headers;
}

export async function createTRPCContext(opts: CreateContextOptions) {
  const session = await auth.api.getSession({ headers: opts.headers });
  return { db, session, headers: opts.headers };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Surface field-level validation errors to the client instead of a
        // generic 500 the UI cannot act on.
        zod: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Logs slow calls; cheap, and the first thing you want when the app feels slow. */
const timing = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  const result = await next();
  const ms = Date.now() - start;
  if (ms > 500) console.warn(`[trpc] slow ${path} took ${ms}ms`);
  return result;
});

export const publicProcedure = t.procedure.use(timing);

export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required." });
  }
  return next({
    ctx: { ...ctx, session: ctx.session, user: ctx.session.user },
  });
});

export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const active = ctx.session.session.activeOrganizationId;
  if (active) {
    return next({ ctx: { ...ctx, organizationId: active } });
  }

  // A session with no active tenant is recoverable: fall back to the user's
  // first membership rather than failing the request.
  //
  // This is not a rare path. On sign-up, better-auth creates the session before
  // our `user.create.after` hook has created the org + membership, so a brand
  // new account's very first session is always unstamped. (Sign-IN sessions get
  // stamped correctly by the `session.create.before` hook.)
  const membership = await ctx.db.member.findFirst({
    where: { userId: ctx.user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No organization for this user.",
    });
  }

  // Self-heal, so this lookup is paid once per session rather than on every
  // request for the lifetime of the account. `updateMany` + catch: warming a
  // cache must never be the reason a request fails.
  try {
    await ctx.db.session.updateMany({
      where: { id: ctx.session.session.id },
      data: { activeOrganizationId: membership.organizationId },
    });
  } catch (err) {
    console.warn("[trpc] could not stamp session with active org:", err);
  }

  return next({ ctx: { ...ctx, organizationId: membership.organizationId } });
});
