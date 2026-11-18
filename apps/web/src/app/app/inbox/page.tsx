import { InboxPage } from "@/components/inbox-page";
import { requireSession } from "@/lib/session";

export default async function Inbox() {
  // Every /app page checks for itself; see app/app/layout.tsx for why.
  await requireSession();
  return <InboxPage />;
}
