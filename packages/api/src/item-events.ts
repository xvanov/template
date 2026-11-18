/**
 * What happens after an item is created, whoever created it: a person in the
 * app or over MCP (items.create), or an approved agent proposal
 * (agent.approve). One place, so both paths behave the same. Called after
 * the transaction committed; never throws for a side effect.
 */
// @module:push-mobile
import { queueAppPush } from "@repo/jobs";
// @end

export async function afterItemCreated(
  organizationId: string,
  itemId: string,
): Promise<void> {
  // @module:push-mobile
  // Teammates' phones (a no-op while mobile push is off; never throws).
  await queueAppPush(organizationId, { kind: "item", id: itemId });
  // @end
}
