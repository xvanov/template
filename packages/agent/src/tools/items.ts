/**
 * The demo tools, over the template's Item model. The reference for adding
 * your own: one read tool, two write tools.
 *
 * The writes (and their input rules) are the DOMAIN FUNCTIONS in
 * @repo/domain — the same ones the tRPC items router calls — so a proposal
 * applied here and a click in the app make exactly the same change, with the
 * same validation and the same audit action.
 */
import {
  createItem,
  createItemInput,
  findItem,
  itemId,
  NotFoundError,
  removeItem,
} from "@repo/domain";
import { z } from "zod";

import { defineReadTool, defineWriteTool } from "../tool";

export const itemsSearch = defineReadTool({
  name: "items_search",
  description:
    "Search this workspace's items by words in the title or notes. Returns id, title, notes and done for each match, newest first. Call with no query to list recent items.",
  input: z.object({
    query: z.string().trim().max(200).optional().describe("Words to look for."),
    includeDone: z.boolean().default(false).describe("Include finished items."),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  run: (ctx, input) =>
    ctx.db.item.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(input.includeDone ? {} : { done: false }),
        ...(input.query
          ? {
              OR: [
                { title: { contains: input.query, mode: "insensitive" } },
                { notes: { contains: input.query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: input.limit,
      select: { id: true, title: true, notes: true, done: true },
    }),
});

/** Marks an audit row as coming from an approved proposal. */
const via = "agent.proposal";

export const itemsCreate = defineWriteTool({
  name: "items_create",
  description: "Create an item in this workspace.",
  input: createItemInput,
  // The title IS what would be created, so it is the summary.
  summarize: async (_ctx, input) => `Create item "${input.title}"`,
  apply: (ctx, input) =>
    createItem(ctx.tx, ctx, input, (action, opts) =>
      ctx.audit(action, { ...opts, metadata: { title: input.title, via } }),
    ),
});

export const itemsDelete = defineWriteTool({
  name: "items_delete",
  description:
    "Delete an item in this workspace (permanent). Use items_search first to find its id.",
  input: z.object({
    id: itemId.describe("An item id from items_search."),
    reason: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe("Why, for the person reviewing the proposal."),
  }),
  // From the database: the reviewer sees the REAL title of what would be
  // deleted, whatever the model claims about it.
  summarize: async (ctx, input) => {
    const item = await findItem(ctx.db, ctx.organizationId, input.id);
    if (!item) {
      throw new NotFoundError(
        `No item ${input.id} in this workspace. Search first.`,
      );
    }
    return `Delete item "${item.title}"`;
  },
  claim: (input) => input.reason,
  apply: (ctx, input) =>
    removeItem(ctx.tx, ctx, { id: input.id }, (action, opts) =>
      ctx.audit(action, { ...opts, metadata: { via } }),
    ),
});
