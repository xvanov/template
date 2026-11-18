"use client";

/**
 * Glance links for Meta Ray-Ban Display glasses (and any small screen): a
 * read-only page of what needs you — approvals and unhandled inbox — at
 * /glance/<secret>, added to the glasses as a Web App. Each member manages
 * their own links; the secret is shown once.
 */
import { useState } from "react";
import { Glasses } from "lucide-react";
import { toast } from "sonner";

import { useFormat } from "@/components/format-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";

/** Meta AI app deep link that adds a Web App to Display glasses. */
export function addToGlassesLink(appName: string, url: string): string {
  const q = new URLSearchParams({ appName, appUrl: url });
  return `fb-viewapp://web_app_deep_link?${q.toString()}`;
}

export function GlassesPage() {
  const format = useFormat();
  const utils = trpc.useUtils();
  const links = trpc.glance.links.useQuery();
  const [name, setName] = useState("My glasses");
  const [created, setCreated] = useState<{ name: string; url: string } | null>(
    null,
  );

  const create = trpc.glance.createLink.useMutation({
    onSuccess: (l) => {
      setCreated({
        name: l.name,
        url: `${window.location.origin}/glance/${l.secret}`,
      });
      void utils.glance.links.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = trpc.glance.revokeLink.useMutation({
    onSuccess: () => {
      toast.success("Link revoked");
      void utils.glance.links.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const https =
    typeof window !== "undefined" && window.location.protocol === "https:";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Glance links</h1>
          </CardTitle>
          <CardDescription>
            A read-only page of what needs you (approvals and unhandled inbox),
            sized for Meta Ray-Ban Display glasses. Anyone with the link can see
            it, so treat it like a password; revoke it if it leaks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate({ name: name.trim() });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="glance-name">Link name</Label>
              <Input
                id="glance-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              <Glasses aria-hidden />
              Create link
            </Button>
          </form>

          {created ? (
            <div
              role="status"
              className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm"
            >
              <p className="font-medium">
                Copy “{created.name}” now — it is not shown again.
              </p>
              <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">
                {created.url}
              </pre>
              {!https ? (
                <p className="text-muted-foreground">
                  The glasses only load HTTPS URLs: open this app through its
                  public HTTPS address before adding the link.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild>
                  <a href={addToGlassesLink(created.name, created.url)}>
                    Add to glasses (Meta AI app)
                  </a>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={created.url} target="_blank" rel="noreferrer">
                    Preview
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCreated(null)}
                >
                  Done
                </Button>
              </div>
              <p className="text-muted-foreground">
                On the phone paired with the glasses, “Add to glasses” opens the
                Meta AI app. Or add it by hand: Meta AI app → App settings →
                Apps → Web Apps → Connect Web App, and paste the URL. Developer
                Mode must be on.
              </p>
            </div>
          ) : null}

          {links.isPending ? (
            <LoadingState label="Loading links…" />
          ) : links.error ? (
            <ErrorState
              error={links.error}
              retry={() => void links.refetch()}
            />
          ) : links.data.length === 0 ? (
            <EmptyState title="No glance links" icon={<Glasses />} />
          ) : (
            <ul className="divide-y rounded-md border">
              {links.data.map((l) => (
                <li
                  key={l.id}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{l.name}</span>
                  <code className="font-mono text-xs text-muted-foreground">
                    {l.prefix}…
                  </code>
                  {l.revokedAt ? (
                    <Badge variant="outline">revoked</Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {l.lastUsedAt
                      ? `used ${format.date(l.lastUsedAt, "datetime")}`
                      : "never used"}
                  </span>
                  {!l.revokedAt ? (
                    <ConfirmDialog
                      trigger={
                        <Button size="sm" variant="ghost" className="ml-auto">
                          Revoke
                        </Button>
                      }
                      title="Revoke this link?"
                      description="The glasses showing it get “not valid” at the next refresh. This cannot be undone."
                      confirmLabel="Revoke"
                      destructive
                      onConfirm={() => revoke.mutate({ id: l.id })}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
