import { AgentPage } from "@/components/agent-page";
import { requireSession } from "@/lib/session";

export default async function Agent() {
  // Every /app page checks for itself; see app/app/layout.tsx for why.
  await requireSession();
  return <AgentPage />;
}
