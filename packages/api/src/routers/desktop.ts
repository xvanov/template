/**
 * What the desktop shell (apps/desktop) turns into OS notifications: the
 * things in this tenant that want a human. Read-only and org-scoped.
 *
 * The shell POLLS this (about every 30 s) with the session the user signed in
 * with inside its window. A poll rather than a tRPC subscription on purpose:
 * these events are written by the worker, another process, and the template
 * has no cross-process pub/sub, so a subscription would poll the database per
 * open connection anyway, and hold a long-lived stream open through every
 * proxy and tunnel in between. A poll costs the same queries and survives
 * sleep, network changes and redeploys with no reconnect logic.
 *
 * Contract (kept small so the Rust side stays generic):
 *   - no `since`: nothing, plus a cursor. The first poll replays no old news.
 *   - with `since` (the previous cursor): what happened after it, plus the
 *     next cursor. The server's clock decides both ends, never the client's.
 *   - each event has a stable `key`; the shell shows a key once. The query
 *     looks back a little before `since` (a row committed late is not lost),
 *     and the key is what stops that overlap from notifying twice.
 *   - title and body are built HERE, from the database, so an app changes
 *     what it notifies about in TypeScript without touching the shell.
 */
import { z } from "zod";

import { createTRPCRouter, orgProcedure, rateLimited } from "../trpc";

/** Rows committed slightly after `now` was read are picked up next poll. */
const OVERLAP_MS = 60_000;
/** A shell that slept for a week does not get a week of notifications. */
const MAX_LOOKBACK_MS = 24 * 3_600_000;
const MAX_PER_KIND = 20;

export interface DesktopEvent {
  key: string;
  kind:
    | "item"
    | "proposal" // @module:agent
    | "agent_run" // @module:agent
    | "inbound"; // @module:inbound
  title: string;
  body: string;
  /** ISO time it happened; the events are returned oldest first. */
  at: string;
}

function clip(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const desktopRouter = createTRPCRouter({
  feed: orgProcedure
    // Two shells per user polling every 30 s is 4 a minute; this is generous.
    .use(rateLimited({ limit: 20, windowSeconds: 60 }))
    .input(
      z
        .object({
          /** The `cursor` of the previous answer (ISO date-time). */
          since: z.string().datetime().optional(),
        })
        .default({}),
    )
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ cursor: string; events: DesktopEvent[] }> => {
        const now = new Date();
        const cursor = now.toISOString();
        if (!input.since) return { cursor, events: [] };

        const sinceMs = Math.min(
          Math.max(Date.parse(input.since), now.getTime() - MAX_LOOKBACK_MS),
          now.getTime(),
        );
        const window = { gt: new Date(sinceMs - OVERLAP_MS), lte: now };
        const organizationId = ctx.organizationId;

        const events: DesktopEvent[] = [];
        const recent = {
          orderBy: { createdAt: "desc" },
          take: MAX_PER_KIND,
        } as const;

        // Items a teammate added: yours are not news.
        const items = await ctx.db.item.findMany({
          ...recent,
          where: {
            organizationId,
            createdById: { not: ctx.user.id },
            createdAt: window,
          },
          select: { id: true, title: true, createdAt: true },
        });
        for (const i of items) {
          events.push({
            key: `item:${i.id}`,
            kind: "item",
            title: "New item",
            body: clip(i.title),
            at: i.createdAt.toISOString(),
          });
        }

        // @module:agent
        const proposals = await ctx.db.agentProposal.findMany({
          ...recent,
          where: { organizationId, status: "pending", createdAt: window },
          select: { id: true, summary: true, createdAt: true },
        });
        for (const p of proposals) {
          events.push({
            key: `proposal:${p.id}`,
            kind: "proposal",
            title: "Waiting for your approval",
            body: clip(p.summary),
            at: p.createdAt.toISOString(),
          });
        }
        // Only the runs YOU started: a teammate's finished run is not news.
        const runs = await ctx.db.agentRun.findMany({
          where: {
            organizationId,
            createdById: ctx.user.id,
            status: { in: ["completed", "failed"] },
            finishedAt: window,
          },
          orderBy: { finishedAt: "desc" },
          take: MAX_PER_KIND,
          select: { id: true, goal: true, status: true, finishedAt: true },
        });
        for (const r of runs) {
          events.push({
            key: `agent_run:${r.id}:${r.status}`,
            kind: "agent_run",
            title:
              r.status === "completed"
                ? "Agent run finished"
                : "Agent run failed",
            body: clip(r.goal),
            at: (r.finishedAt ?? now).toISOString(),
          });
        }
        // @end

        // @module:inbound
        const inbound = await ctx.db.inboundMessage.findMany({
          ...recent,
          where: { organizationId, createdAt: window },
          select: {
            id: true,
            channel: true,
            fromAddress: true,
            subject: true,
            createdAt: true,
          },
        });
        for (const m of inbound) {
          events.push({
            key: `inbound:${m.id}`,
            kind: "inbound",
            title: m.channel === "sms" ? "New text message" : "New email",
            body: clip(
              m.subject
                ? `${m.fromAddress}: ${m.subject}`
                : `From ${m.fromAddress}`,
            ),
            at: m.createdAt.toISOString(),
          });
        }
        // @end

        events.sort((a, b) => a.at.localeCompare(b.at));
        return { cursor, events };
      },
    ),
});
