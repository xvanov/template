/**
 * The MCP endpoint (streamable HTTP, stateless, JSON responses):
 *
 *   claude mcp add --transport http app https://app.example.com/api/mcp \
 *     --header "Authorization: Bearer tk_..."
 *
 * A route handler, not tRPC: the caller is a machine authenticated by an
 * organization API key (created by an owner/admin at /app/agent), not a
 * session. Everything after authentication is tRPC: the MCP tools call the
 * app's own procedures through a caller bound to the key's organization
 * (packages/api/src/mcp.ts), so tenant isolation and audit are theirs.
 *
 * Rate limited per key (MCP_RATE_LIMIT_PER_MINUTE), and failed
 * authentications per IP. Both fail OPEN if Redis is down, like the tRPC
 * throttle: they protect our capacity, not other people.
 */
import { authenticateApiKey, bearerApiKey } from "@repo/api";
import { handleMcpRequest } from "@repo/api/mcp";
import { db } from "@repo/db";
import { env } from "@repo/env";
import { clientIp, rateLimit, tooManyRequests } from "@repo/security";

export const dynamic = "force-dynamic";

const unauthorized = () =>
  Response.json(
    { error: "A valid API key is required: Authorization: Bearer tk_..." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } },
  );

/** null = allowed (or the limiter is down); else the 429 to send. */
async function throttle(key: string, limit: number) {
  try {
    const r = await rateLimit({ key, limit, windowSeconds: 60 });
    return r.allowed ? null : tooManyRequests(r);
  } catch (err) {
    console.warn(`[mcp] rate limiter unavailable for ${key}, allowing:`, err);
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  const secret = bearerApiKey(req.headers.get("authorization"));
  const principal = secret ? await authenticateApiKey(db, secret) : null;
  if (!principal) {
    const ip = clientIp(req.headers) ?? "unknown";
    return (await throttle(`mcp:unauthorized:${ip}`, 30)) ?? unauthorized();
  }
  const limited = await throttle(
    `mcp:key:${principal.id}`,
    env().MCP_RATE_LIMIT_PER_MINUTE,
  );
  if (limited) return limited;
  return handleMcpRequest(req, principal);
}

/**
 * Stateless server: no server-initiated stream (GET) and no session to end
 * (DELETE). A 405 tells a client so; an empty 200 event stream would have it
 * reconnect in a loop and burn the key's rate limit.
 */
function methodNotAllowed(): Response {
  return Response.json(
    { error: "Method not allowed: this MCP server is stateless, POST only." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export { handle as POST, methodNotAllowed as GET, methodNotAllowed as DELETE };
