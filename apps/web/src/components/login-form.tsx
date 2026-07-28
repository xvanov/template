"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { authClient } from "@repo/auth/client";

import { Button, Card, ErrorText, Hint, Input } from "./ui";

type Mode = "signin" | "signup";

export function LoginForm({
  googleEnabled,
  mode,
}: {
  googleEnabled: boolean;
  mode: Mode;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Test seam, and a real one: submitting depends on the React handler being
  // attached, which happens at hydration. `data-hydrated` lets an end-to-end
  // test wait for that instead of racing it — the alternative is an
  // intermittently-failing suite that gets "fixed" with sleeps.
  useEffect(() => {
    formRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
            });

      if (result.error) {
        setError(result.error.message ?? "Could not sign in.");
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

  return (
    <Card>
      <h1 className="text-xl font-semibold">
        {mode === "signin" ? "Sign in" : "Create an account"}
      </h1>
      <Hint className="mt-1">
        {mode === "signin"
          ? "Email and password work with no external setup."
          : "You will get your own workspace immediately."}
      </Hint>

      <form ref={formRef} onSubmit={submit} className="mt-5 space-y-3">
        {mode === "signup" && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">Name</span>
            <Input
              name="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
            />
          </label>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <Input
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Password</span>
          <Input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={
              mode === "signin" ? "current-password" : "new-password"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="at least 8 characters"
          />
        </label>

        <ErrorText>{error}</ErrorText>

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
        </Button>
      </form>

      {googleEnabled ? (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-[var(--color-muted)]">
            <span className="h-px flex-1 bg-[var(--color-border)]" />
            or
            <span className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
          <Button
            variant="secondary"
            onClick={google}
            disabled={busy}
            className="w-full"
          >
            Continue with Google
          </Button>
        </>
      ) : (
        <Hint className="mt-4 text-xs">
          Google sign-in is hidden because GOOGLE_CLIENT_ID /
          GOOGLE_CLIENT_SECRET are unset. See .env.example for the two-minute
          setup.
        </Hint>
      )}

      <Link
        href={mode === "signin" ? "/login?mode=signup" : "/login"}
        className="mt-5 inline-block text-sm text-[var(--color-accent)] underline-offset-4 hover:underline"
      >
        {mode === "signin"
          ? "No account? Create one"
          : "Already have an account? Sign in"}
      </Link>
    </Card>
  );
}
