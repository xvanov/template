/**
 * Session + tenant for the few plain route handlers (file bytes). Resolves the
 * tenant exactly as `orgProcedure` does — same function — including the repair
 * of a brand-new account's first session, which has no activeOrganizationId.
 * The tenant comes from the session, never from the request.
 *
 *   const tenant = await requireTenant(req);
 *   if (!tenant) return new Response("Unauthorized", { status: 401 });
 */
import { resolveOrganizationId } from "@repo/api";
import { auth } from "@repo/auth";
import { db } from "@repo/db";

export async function requireTenant(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return null;
  const organizationId = await resolveOrganizationId(db, session);
  if (!organizationId) return null;
  return { session, userId: session.user.id, organizationId };
}
