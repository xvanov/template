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
 * Inside `orgProcedure`, `ctx.audit(action, ...)` writes an audit_event row
 * stamped with the actor, tenant, IP and user agent. Pass the transaction
 * client when there is one, so the row commits with the change it describes.
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
import { db, recordAudit, type AuditWriter, type Prisma } from "@repo/db";
import { env } from "@repo/env";
import { clientIp, rateLimit } from "@repo/security";

import { domainErrorCode } from "./errors";

export interface CreateContextOptions {
  headers: Headers;
}

/**
 * Set when the caller is a machine with an org API key (the MCP endpoint),
 * not a browser session. See ./api-keys.ts: such a caller acts AS the member
 * who created the key, in the key's organization.
 */
export interface ApiKeyIdentity {
  id: string;
  canWrite: boolean;
}

export interface TRPCContextShape {
  db: typeof db;
  session: Awaited<ReturnType<typeof auth.api.getSession>>;
  headers: Headers;
  /** Absent/null for a browser session. */
  apiKey?: ApiKeyIdentity | null;
}

export async function createTRPCContext(
  opts: CreateContextOptions,
): Promise<TRPCContextShape> {
  const session = await auth.api.getSession({ headers: opts.headers });
  return { db, session, headers: opts.headers, apiKey: null };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // An INTERNAL_SERVER_ERROR is something we did not anticipate: its message
    // may be a SQL fragment, a file path or an upstream response. In
    // production the client gets a fixed sentence and no stack; the real error
    // is logged by the route handler's onError. Expected failures are thrown
    // as typed errors (./errors) and keep their message.
    const opaque = error.code === "INTERNAL_SERVER_ERROR" && isProduction();
    const { stack: _stack, ...data } = shape.data;
    return {
      ...shape,
      message: opaque ? "Something went wrong on our side." : shape.message,
      data: {
        ...(isProduction() ? data : shape.data),
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

/** Read lazily: importing this module must not validate the environment. */
function isProduction(): boolean {
  try {
    return env().NODE_ENV === "production";
  } catch {
    return true; // cannot tell: fail closed, i.e. reveal nothing
  }
}

/**
 * Typed domain errors (./errors) become their tRPC code with their message,
 * and a unique-constraint violation (Prisma P2002) becomes CONFLICT with a
 * generic message. Anything else stays an opaque INTERNAL_SERVER_ERROR (see
 * errorFormatter). A TRPCError a resolver threw on purpose is left alone, even
 * when its cause is a domain error: the resolver chose that code.
 */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && wrappedByTrpc(result.error)) {
    const cause = result.error.cause;
    const code = domainErrorCode(cause);
    if (code && cause instanceof Error) {
      throw new TRPCError({ code, message: cause.message, cause });
    }
    if (isUniqueViolation(cause)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "That already exists.",
        cause,
      });
    }
  }
  return result;
});

/**
 * True when tRPC wrapped a non-TRPCError the resolver threw (it copies the
 * cause's stack onto the wrapper), false for a TRPCError thrown on purpose.
 */
function wrappedByTrpc(error: TRPCError): boolean {
  return (
    error.code === "INTERNAL_SERVER_ERROR" &&
    error.cause instanceof Error &&
    error.stack === error.cause.stack
  );
}

/** Prisma's unique-constraint error, matched by code (no client import). */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === "P2002" &&
    err.name === "PrismaClientKnownRequestError"
  );
}

export const publicProcedure = t.procedure.use(timing).use(domainErrors);

export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required." });
  }
  return next({
    ctx: { ...ctx, session: ctx.session, user: ctx.session.user },
  });
});

export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const organizationId = await resolveOrganizationId(ctx.db, ctx.session);
  // An API key is bound to ONE organization. resolveOrganizationId falls back
  // to the user's first membership when they left the active org; for a
  // browser that is a convenience, for a key it would be a cross-tenant leak.
  if (
    ctx.apiKey &&
    organizationId !== ctx.session.session.activeOrganizationId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This API key's creator is no longer a member of its workspace.",
    });
  }
  if (!organizationId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No organization for this user.",
    });
  }
  return next({ ctx: withAudit(ctx, organizationId) });
});

/**
 * An org procedure for owners and admins only, checked against this tenant's
 * membership row (never a claim from the client).
 *
 *   const adminProcedure = adminOnlyProcedure("manage API keys");
 */
export function adminOnlyProcedure(what: string) {
  return orgProcedure.use(async ({ ctx, next }) => {
    const me = await ctx.db.member.findFirst({
      where: { organizationId: ctx.organizationId, userId: ctx.user.id },
      select: { role: true },
    });
    // better-auth stores multiple roles comma-separated ("owner,admin").
    const roles = (me?.role ?? "").split(",").map((r) => r.trim());
    if (!roles.includes("owner") && !roles.includes("admin")) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Only an owner or admin can ${what}.`,
      });
    }
    return next();
  });
}

type Session = NonNullable<TRPCContext["session"]>;

/**
 * The tenant a signed-in session acts in: its active organization IF the user
 * is still a member of it, else the user's first membership. Null = the user
 * belongs to no organization.
 *
 * The membership check is not optional: better-auth clears
 * `activeOrganizationId` only when a user removes THEMSELF, so a member an
 * admin removed keeps a session stamped with the org they just lost. Trusting
 * the stamp would let them keep reading it. The check is one lookup on the
 * (organizationId, userId) unique index.
 *
 * Shared by `orgProcedure` and the plain route handlers (`requireTenant` in
 * apps/web), so the two cannot disagree about who the tenant is. The tenant
 * always comes from the session, never from the request.
 */
export async function resolveOrganizationId(
  client: typeof db,
  session: Session,
): Promise<string | null> {
  const active = session.session.activeOrganizationId;
  if (active) {
    const stillMember = await client.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: active,
          userId: session.user.id,
        },
      },
      select: { id: true },
    });
    if (stillMember) return active;
  }

  // No usable active tenant: fall back to the user's first membership rather
  // than failing the request.
  //
  // This is not a rare path. On sign-up, better-auth creates the session before
  // our `user.create.after` hook has created the org + membership, so a brand
  // new account's very first session is always unstamped. (Sign-IN sessions get
  // stamped correctly by the `session.create.before` hook.) The other way here
  // is a stamp for an org the user was removed from.
  const membership = await client.member.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  const organizationId = membership?.organizationId ?? null;

  // Self-heal (also clears a stale stamp), so this lookup is paid once per
  // session rather than on every request. `updateMany` + catch: warming a
  // cache must never be the reason a request fails.
  if (organizationId !== active) {
    try {
      await client.session.updateMany({
        where: { id: session.session.id },
        data: { activeOrganizationId: organizationId },
      });
    } catch (err) {
      console.warn("[trpc] could not stamp session with active org:", err);
    }
  }
  return organizationId;
}

export interface AuditOptions {
  /** Defaults to the action's prefix: `item.delete` → `item`. */
  targetType?: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

function withAudit<C extends TRPCContext & { user: { id: string } }>(
  ctx: C,
  organizationId: string,
) {
  /**
   * Record an audit event in this tenant, as this user.
   *
   *   await ctx.audit("item.delete", { targetId: id }, tx);
   */
  const audit = (
    action: string,
    opts: AuditOptions = {},
    client: AuditWriter = ctx.db,
  ) =>
    recordAudit(client, {
      organizationId,
      actorType: "user",
      actorId: ctx.user.id,
      action,
      targetType: opts.targetType ?? action.split(".")[0] ?? action,
      targetId: opts.targetId,
      metadata: viaApiKey(opts.metadata, ctx.apiKey),
      ip: clientIp(ctx.headers),
      userAgent: ctx.headers.get("user-agent"),
    });
  return { ...ctx, organizationId, audit };
}

/** A change made through an API key says which key, in its audit metadata. */
function viaApiKey(
  metadata: Prisma.InputJsonValue | undefined,
  apiKey: ApiKeyIdentity | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!apiKey) return metadata;
  if (metadata === undefined) return { apiKeyId: apiKey.id };
  if (typeof metadata === "object" && !Array.isArray(metadata)) {
    return { ...metadata, apiKeyId: apiKey.id };
  }
  return { value: metadata, apiKeyId: apiKey.id };
}

/**
 * Per-caller throttle for one procedure: by user when signed in, else by IP.
 *
 *   expensive: orgProcedure.use(rateLimited({ limit: 10, windowSeconds: 60 }))
 *
 * Shared across processes through Redis. Fails OPEN (with a warning) if Redis
 * is unreachable: this protects our capacity, not other people, so a Redis
 * blip should not become an outage. Outbound message caps fail closed instead.
 */
export function rateLimited(opts: { limit: number; windowSeconds: number }) {
  return t.middleware(async ({ ctx, path, next }) => {
    const who = ctx.session?.user
      ? `user:${ctx.session.user.id}`
      : `ip:${clientIp(ctx.headers) ?? "unknown"}`;
    try {
      const r = await rateLimit({ key: `trpc:${path}:${who}`, ...opts });
      if (!r.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Too many requests. Try again in ${r.resetSeconds}s.`,
        });
      }
    } catch (err) {
      if (err instanceof TRPCError) throw err;
      console.warn(
        `[trpc] rate limiter unavailable for ${path}, allowing:`,
        err,
      );
    }
    return next();
  });
}
