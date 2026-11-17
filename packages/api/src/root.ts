import { activityRouter } from "./routers/activity";
import { agentRouter } from "./routers/agent";
import { apiKeysRouter } from "./routers/api-keys";
import { aiRouter } from "./routers/ai";
import { healthRouter } from "./routers/health";
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
  activity: activityRouter,
  agent: agentRouter,
  apiKeys: apiKeysRouter,
});

export type AppRouter = typeof appRouter;
