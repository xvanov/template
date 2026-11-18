import { DocsPage } from "@/components/docs-page";
import { requireSession } from "@/lib/session";

export default async function Docs() {
  // Every /app page checks for itself; see app/app/layout.tsx for why.
  await requireSession();
  return <DocsPage />;
}
