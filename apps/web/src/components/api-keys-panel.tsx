"use client";

/**
 * Organization API keys for MCP clients (owners and admins). The secret is
 * shown once, right after creation, with the command that connects Claude
 * Code to this workspace.
 */
import { useState } from "react";
import { KeyRound } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

export function ApiKeysPanel() {
  const format = useFormat();
  const utils = trpc.useUtils();
  const keys = trpc.apiKeys.list.useQuery();
  const [name, setName] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const [created, setCreated] = useState<{
    name: string;
    secret: string;
  } | null>(null);

  const create = trpc.apiKeys.create.useMutation({
    onSuccess: (k) => {
      setCreated({ name: k.name, secret: k.secret });
      setName("");
      setCanWrite(false);
      void utils.apiKeys.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      toast.success("Key revoked");
      void utils.apiKeys.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>API keys (MCP)</h2>
        </CardTitle>
        <CardDescription>
          Connect Claude Code or Claude Desktop to this workspace at{" "}
          <code className="font-mono">/api/mcp</code>. A key acts as you.
          Without write access, its changes wait in the approval queue and it
          cannot start agent runs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name: name.trim(), canWrite });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="key-name">Key name</Label>
            <Input
              id="key-name"
              placeholder="e.g. my laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="key-write"
              checked={canWrite}
              onCheckedChange={setCanWrite}
            />
            <Label htmlFor="key-write">Can write directly</Label>
          </div>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            <KeyRound aria-hidden />
            Create key
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
            <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs">
              {created.secret}
            </pre>
            <p className="text-muted-foreground">Connect Claude Code:</p>
            <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {`claude mcp add --transport http app ${origin}/api/mcp --header "Authorization: Bearer ${created.secret}"`}
            </pre>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreated(null)}
            >
              Done
            </Button>
          </div>
        ) : null}

        {keys.isPending ? (
          <LoadingState label="Loading keys…" />
        ) : keys.error ? (
          <ErrorState error={keys.error} retry={() => void keys.refetch()} />
        ) : keys.data.length === 0 ? (
          <EmptyState title="No API keys" icon={<KeyRound />} />
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.data.map((k) => (
              <li
                key={k.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">{k.name}</span>
                <code className="font-mono text-xs text-muted-foreground">
                  {k.prefix}…
                </code>
                <Badge variant={k.canWrite ? "default" : "secondary"}>
                  {k.canWrite ? "write" : "proposals"}
                </Badge>
                {k.revokedAt ? <Badge variant="outline">revoked</Badge> : null}
                <span className="text-xs text-muted-foreground">
                  {k.lastUsedAt
                    ? `used ${format.date(k.lastUsedAt, "datetime")}`
                    : "never used"}
                </span>
                {!k.revokedAt ? (
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="ghost" className="ml-auto">
                        Revoke
                      </Button>
                    }
                    title="Revoke this key?"
                    description="Clients using it stop working at once. This cannot be undone."
                    confirmLabel="Revoke"
                    destructive
                    onConfirm={() => revoke.mutate({ id: k.id })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
