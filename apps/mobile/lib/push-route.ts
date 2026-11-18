/**
 * Where tapping a push should land, from its `data` (packages/push-mobile
 * puts `kind` and `id` there, nothing else). Pure, so it is a unit test.
 * Unknown or malformed data opens nothing: the app just comes forward.
 */
export type PushRoute =
  | "/items"
  | `/proposal/${string}` // @module:agent
  | `/inbox/${string}`; // @module:inbound

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function routeForPush(data: unknown): PushRoute | null {
  if (!data || typeof data !== "object") return null;
  const { kind, id } = data as { kind?: unknown; id?: unknown };
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (kind === "item") return "/items";
  if (kind === "proposal") return `/proposal/${id}`; // @module:agent
  if (kind === "inbound") return `/inbox/${id}`; // @module:inbound
  return null;
}
