/**
 * The demo tools, over the template's Item model. The reference for adding
 * your own: one read tool, two write tools.
 *
 * Every query pins the tenant from the CONTEXT, and every write goes through
 * `updateMany`/`deleteMany` with the org in the `where` — the same rules as
 * packages/api/src/routers/items.ts, whose audit actions these reuse.
 */
import { z } from "zod";

import { NotFoundError } from "../errors";
import { defineReadTool, defineWriteTool } from "../tool";

const itemId = z
  .string()
  .min(1)
  .max(64)
  .describe("An item id from items_search.");

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

export const itemsCreate = defineWriteTool({
  name: "items_create",
  description: "Create an item in this workspace.",
  input: z.object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).optional(),
  }),
  describe: (input) => `Create item "${input.title}"`,
  apply: async (ctx, input) => {
    const item = await ctx.tx.item.create({
      data: {
        organizationId: ctx.organizationId,
        title: input.title,
        notes: input.notes,
        createdById: ctx.userId,
      },
      select: { id: true, title: true },
    });
    await ctx.audit("item.create", {
      targetId: item.id,
      metadata: { title: item.title, via: "agent.proposal" },
    });
    return item;
  },
});

export const itemsDelete = defineWriteTool({
  name: "items_delete",
  description:
    "Delete an item in this workspace (permanent). Use items_search first to find its id.",
  input: z.object({
    id: itemId,
    reason: z
      .string()
      .trim()
      .max(300)
      .optional()
      .describe("Why, for the reviewer."),
  }),
  describe: (input) =>
    `Delete item ${input.id}${input.reason ? ` (${input.reason})` : ""}`,
  check: async (ctx, input) =>
    (await ctx.db.item.count({
      where: { id: input.id, organizationId: ctx.organizationId },
    }))
      ? null
      : `No item ${input.id} in this workspace. Search first.`,
  apply: async (ctx, input) => {
    const { count } = await ctx.tx.item.deleteMany({
      where: { id: input.id, organizationId: ctx.organizationId },
    });
    // Same message whether it never existed or another tenant owns it.
    if (count === 0) throw new NotFoundError("That item no longer exists.");
    await ctx.audit("item.delete", {
      targetId: input.id,
      metadata: { via: "agent.proposal" },
    });
    return { id: input.id, deleted: true };
  },
});
