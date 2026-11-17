import type { Metadata } from "next";

import { Toaster } from "@/components/ui/sonner";

import { Styleguide } from "./styleguide";

/**
 * Internal styleguide: every kit component with sample data, in one page.
 * Static (no request data, no API calls, no auth) and kept out of search
 * engines. Agents: read this page's source to see how each component is used.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

export default function DesignPage() {
  return (
    <>
      <Styleguide />
      <Toaster richColors closeButton />
    </>
  );
}
