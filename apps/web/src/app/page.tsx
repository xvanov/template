import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, CardTitle, Hint } from "@/components/ui";
import { getServerSession } from "@/lib/session";

/**
 * Per-user page: it reads the session cookie, so it must be rendered per request
 * and never cached. Being explicit also stops `next build` from attempting a
 * prerender, which would make compiling the app require runtime secrets.
 */
export const dynamic = "force-dynamic";
export default async function Home() {
  const session = await getServerSession();
  if (session?.user) redirect("/app");

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <p className="text-sm font-medium tracking-wide text-[var(--color-accent)] uppercase">
          App template
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          One backend. Web and phone.
        </h1>
        <Hint className="mt-3 text-base">
          Next.js + Expo sharing a typed tRPC API, Prisma/Postgres, better-auth,
          a Redis worker, LLM plumbing and file storage — all wired and running.
        </Hint>
      </div>

      <Link
        href="/login"
        className="inline-flex w-fit items-center rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90"
      >
        Sign in to the demo
      </Link>

      <Card>
        <CardTitle>What to do next</CardTitle>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--color-muted)]">
          <li>
            Sign in, then exercise items, the AI box, an upload and a background
            job on the dashboard.
          </li>
          <li>
            Run the same thing on your phone:{" "}
            <code className="font-mono">make mobile</code> and scan the QR code
            with Expo Go.
          </li>
          <li>
            Rename the demo <code className="font-mono">Item</code> model to
            your own domain and delete what you do not need.
          </li>
        </ol>
      </Card>
    </main>
  );
}
