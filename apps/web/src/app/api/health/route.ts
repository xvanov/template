/**
 * Plain-HTTP health endpoint for container healthchecks, load balancers and
 * the smoke gate — deliberately not tRPC, so it needs no client to call.
 */
import { appRouter, createTRPCContext } from "@repo/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: req.headers }),
  );
  try {
    const result = await caller.health.ready();
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
