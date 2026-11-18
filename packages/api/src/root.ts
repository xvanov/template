import { activityRouter } from "./routers/activity";
import { agentRouter } from "./routers/agent"; // @module:agent
import { apiKeysRouter } from "./routers/api-keys"; // @module:agent
import { desktopRouter } from "./routers/desktop"; // @module:desktop
import { docsRouter } from "./routers/docs"; // @module:rag
import { glanceRouter } from "./routers/glance"; // @module:glasses
import { aiRouter } from "./routers/ai"; // @module:ai
import { healthRouter } from "./routers/health";
import { inboxRouter } from "./routers/inbox"; // @module:inbound
import { itemsRouter } from "./routers/items";
import { mediaRouter } from "./routers/media";
import { orgRouter } from "./routers/org";
import { pushRouter } from "./routers/push"; // @module:push-mobile
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  health: healthRouter,
  org: orgRouter,
  items: itemsRouter,
  ai: aiRouter, // @module:ai
  media: mediaRouter,
  docs: docsRouter, // @module:rag
  activity: activityRouter,
  agent: agentRouter, // @module:agent
  apiKeys: apiKeysRouter, // @module:agent
  inbox: inboxRouter, // @module:inbound
  desktop: desktopRouter, // @module:desktop
  push: pushRouter, // @module:push-mobile
  glance: glanceRouter, // @module:glasses
});

export type AppRouter = typeof appRouter;
