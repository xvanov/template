import { Dashboard } from "@/components/dashboard";
import { requireSession } from "@/lib/session";

export default async function AppPage() {
  // Every /app page checks for itself; see app/app/layout.tsx for why.
  await requireSession();
  return <Dashboard />;
}
