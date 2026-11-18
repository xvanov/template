import Link from "next/link";
import { redirect } from "next/navigation";

import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      <ThemeToggle className="absolute top-4 right-4" />
      <div>
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          App template
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          One backend, already running.
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          A typed tRPC API, Prisma/Postgres, better-auth, a Redis worker and
          file storage — all wired and running.
        </p>
      </div>

      <Link href="/login" className={buttonVariants({ className: "w-fit" })}>
        Sign in to the demo
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>What to do next</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              Sign in, then exercise items, an upload and a background job on
              the dashboard.
            </li>
            {/* @module:mobile */}
            <li>
              Run the same thing on your phone:{" "}
              <code className="font-mono">make mobile</code> and scan the QR
              code with Expo Go.
            </li>
            {/* @end */}
            <li>
              Rename the demo <code className="font-mono">Item</code> model to
              your own domain and delete what you do not need.
            </li>
            <li>
              Browse every UI component at{" "}
              <Link href="/design" className="underline underline-offset-4">
                /design
              </Link>
              .
            </li>
          </ol>
        </CardContent>
      </Card>
    </main>
  );
}
