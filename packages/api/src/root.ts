import { activityRouter } from "./routers/activity";
import { agentRouter } from "./routers/agent";
import { apiKeysRouter } from "./routers/api-keys";
import { desktopRouter } from "./routers/desktop";
import { docsRouter } from "./routers/docs";
import { aiRouter } from "./routers/ai";
import { healthRouter } from "./routers/health";
import { inboxRouter } from "./routers/inbox";
import { itemsRouter } from "./routers/items";
import { mediaRouter } from "./routers/media";
import { orgRouter } from "./routers/org";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  org: orgRouter,
  items: itemsRouter,
  ai: aiRouter,
  media: mediaRouter,
  docs: docsRouter,
  activity: activityRouter,
  agent: agentRouter,
  apiKeys: apiKeysRouter,
  inbox: inboxRouter,
  desktop: desktopRouter,
});

export type AppRouter = typeof appRouter;
