import { GlassesPage } from "@/components/glasses-page";
import { requireSession } from "@/lib/session";

export const metadata = { title: "Glasses" };

export default async function Glasses() {
  // Every /app page checks for itself; see app/app/layout.tsx for why.
  await requireSession();
  return <GlassesPage />;
}
