"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { useForm } from "react-hook-form";
// zod/mini, not "zod": same schemas, but tree-shakable — classic zod adds
// ~60 kB gzipped to a browser bundle. Server code keeps classic zod.
import {
  email,
  maxLength,
  minLength,
  object,
  string,
  type infer as Infer,
} from "zod/mini";
import { authClient } from "@repo/auth/client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { FieldError } from "@/components/ui/states";

type Mode = "signin" | "signup";

const schema = object({
  name: string().check(maxLength(100)),
  email: email("Enter a valid email address."),
  password: string().check(minLength(8, "At least 8 characters.")),
});
type Values = Infer<typeof schema>;

const linkClass =
  "text-sm font-medium underline-offset-4 hover:underline focus-visible:underline";

export function LoginForm({
  googleEnabled,
  mode,
  devInboxUrl,
}: {
  googleEnabled: boolean;
  mode: Mode;
  /** Local dev mail inbox, when one is configured. See DEV_MAIL_INBOX_URL. */
  devInboxUrl?: string | null;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Test seam, and a real one: submitting depends on the React handler being
  // attached, which happens at hydration. `data-hydrated` lets an end-to-end
  // test wait for that instead of racing it — the alternative is an
  // intermittently-failing suite that gets "fixed" with sleeps.
  useEffect(() => {
    formRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  async function submit({ name, email, password }: Values) {
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name || email,
              // Where the confirmation link lands once the address is verified.
              callbackURL: "/app",
            });

      if (result.error) {
        setError(result.error.message ?? "Could not sign in.");
        return;
      }

      // With verification required, sign-up returns a user but NO session — the
      // account is not usable yet. Navigating to /app would just bounce back
      // here, so show the next step instead.
      const token = (result.data as { token?: string | null } | null)?.token;
      if (mode === "signup" && !token) {
        setSentTo(email);
        return;
      }

      // A full navigation, not router.push: the session cookie has to be
      // attached to the next request for the server component to see it.
      window.location.assign("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    setBusy(true);
    try {
      await authClient.signIn.social({
        provider: "google",
        callbackURL: "/app",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed.");
      setBusy(false);
    }
  }

  async function resend() {
    if (!sentTo) return;
    setError(null);
    setBusy(true);
    try {
      await authClient.sendVerificationEmail({
        email: sentTo,
        callbackURL: "/app",
      });
      setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend.");
    } finally {
      setBusy(false);
    }
  }

  // Post-sign-up: the account exists but is not usable until the address is
  // confirmed. Say exactly that, and give a way out of a lost email.
  if (sentTo) {
    return (
      <Card>
        <CardHeader>
          <MailCheck
            aria-hidden
            className="mb-2 size-6 text-muted-foreground"
          />
          <CardTitle>
            <h1 className="text-xl">Confirm your email</h1>
          </CardTitle>
          <CardDescription data-testid="verify-sent">
            We sent a confirmation link to{" "}
            <strong className="text-foreground">{sentTo}</strong>. Open it to
            finish setting up your account — you will be signed in
            automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Development only. Without this, mail sent to a local catcher looks
              exactly like mail that was never sent: you check your real inbox,
              find nothing, and assume the feature is broken. */}
          {devInboxUrl && (
            <p className="rounded-md border bg-muted p-3 text-sm">
              <strong>Development:</strong> mail is delivered to a local inbox,
              not to the real address.{" "}
              <a
                href={devInboxUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-4"
              >
                Open the local inbox
              </a>{" "}
              to find the link.
            </p>
          )}
          <FieldError>{error}</FieldError>
        </CardContent>
        <CardFooter className="gap-3">
          <Button variant="outline" onClick={resend} disabled={busy || resent}>
            {resent ? "Link sent" : busy ? "Sending…" : "Resend link"}
          </Button>
          <Link href="/login" className={linkClass}>
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">
            {mode === "signin" ? "Sign in" : "Create an account"}
          </h1>
        </CardTitle>
        <CardDescription>
          {mode === "signin"
            ? "Email and password work with no external setup."
            : "You will get your own workspace immediately."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Form {...form}>
          <form
            ref={formRef}
            onSubmit={form.handleSubmit(submit)}
            noValidate
            className="space-y-4"
          >
            {mode === "signup" && (
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input
                        autoComplete="name"
                        placeholder="Ada Lovelace"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete={
                        mode === "signin" ? "current-password" : "new-password"
                      }
                      placeholder="at least 8 characters"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FieldError>{error}</FieldError>

            <Button type="submit" disabled={busy} className="w-full">
              {busy
                ? "Working…"
                : mode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>
        </Form>

        {googleEnabled ? (
          <>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              or
              <Separator className="flex-1" />
            </div>
            <Button
              variant="outline"
              onClick={google}
              disabled={busy}
              className="w-full"
            >
              Continue with Google
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Google sign-in is hidden because GOOGLE_CLIENT_ID /
            GOOGLE_CLIENT_SECRET are unset. See .env.example for the two-minute
            setup.
          </p>
        )}
      </CardContent>

      <CardFooter>
        <Link
          href={mode === "signin" ? "/login?mode=signup" : "/login"}
          className={linkClass}
        >
          {mode === "signin"
            ? "No account? Create one"
            : "Already have an account? Sign in"}
        </Link>
      </CardFooter>
    </Card>
  );
}
