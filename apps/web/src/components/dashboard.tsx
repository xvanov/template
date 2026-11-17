"use client";

/**
 * The "hello world" that proves the whole stack is alive: one screen touching
 * auth, the tenant, the database, the typed API, the LLM, blob storage and the
 * background worker. It is also what the smoke gate drives.
 *
 * Built only from the kit in components/ui — use it as the reference for how a
 * page is put together (states, forms, tables, toasts).
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useFormat } from "@/components/format-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { FileDrop } from "@/components/ui/file-drop";
import { Input } from "@/components/ui/input";
import {
  EmptyState,
  ErrorState,
  FieldError,
  LoadingState,
} from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";

type Item = RouterOutputs["items"]["list"][number];

export function Dashboard() {
  const format = useFormat();
  const items = trpc.items.list.useQuery({ includeDone: true, limit: 50 });
  const aiEnabled = trpc.ai.enabled.useQuery();
  const media = trpc.media.list.useQuery({ limit: 12 });
  const jobs = trpc.items.recentJobs.useQuery();

  const invalidateItems = () => void items.refetch();

  // Mutations report through toasts. Never put user text (the item title) in
  // a toast: it would duplicate text the list already shows.
  const create = trpc.items.create.useMutation({
    onSuccess: () => {
      invalidateItems();
      toast.success("Item added");
    },
    onError: (err) => toast.error(err.message),
  });
  const setDone = trpc.items.setDone.useMutation({
    onSuccess: invalidateItems,
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.items.remove.useMutation({
    onSuccess: () => {
      invalidateItems();
      toast.success("Item deleted");
    },
    onError: (err) => toast.error(err.message),
  });
  const queueSummary = trpc.items.queueSummary.useMutation({
    onError: (err) => toast.error(err.message),
    onSuccess: () => {
      toast.info("Job queued — the worker will pick it up.");
      // The worker writes the outcome asynchronously; poll once after a beat.
      setTimeout(() => void jobs.refetch(), 1500);
    },
  });
  const askAi = trpc.ai.ask.useMutation();

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("Give me one tip for shipping faster.");
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      await uploadFile(file);
      await media.refetch();
      toast.success("File uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const columns: DataTableColumn<Item>[] = [
    {
      key: "done",
      header: "Done",
      className: "w-12",
      sortValue: (item) => (item.done ? 1 : 0),
      cell: (item) => (
        <Checkbox
          checked={item.done}
          // The accessible name stays constant; the checked state carries the
          // status. A name that flips with state re-labels the control out from
          // under assistive tech (and under any test) mid-click.
          aria-label={`Toggle "${item.title}"`}
          onCheckedChange={(checked) =>
            setDone.mutate({ id: item.id, done: checked === true })
          }
        />
      ),
    },
    {
      key: "title",
      header: "Title",
      sortValue: (item) => item.title,
      cell: (item) => (
        <span
          className={cn(
            "whitespace-normal",
            item.done && "text-muted-foreground line-through",
          )}
        >
          {item.title}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      className: "hidden sm:table-cell",
      sortValue: (item) => item.createdAt,
      cell: (item) => (
        <span className="text-muted-foreground">
          {format.date(item.createdAt, "datetime")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "w-12",
      cell: (item) => (
        <ConfirmDialog
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete "${item.title}"`}
            >
              <Trash2 className="text-destructive" />
            </Button>
          }
          title="Delete this item?"
          description="It is removed for everyone in the workspace. This cannot be undone."
          confirmLabel="Delete"
          destructive
          onConfirm={() => remove.mutate({ id: item.id })}
        />
      ),
    },
  ];

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          One screen that exercises every part of the stack.
        </p>
      </div>

      {/* ── items: the database + typed API round trip ────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Items</h2>
          </CardTitle>
          <CardDescription>
            Scoped to this workspace. Another tenant cannot see these rows.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const value = title.trim();
              if (!value) return;
              create.mutate({ title: value });
              setTitle("");
            }}
          >
            <Input
              aria-label="New item title"
              placeholder="Add an item…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Button type="submit" disabled={create.isPending || !title.trim()}>
              Add
            </Button>
          </form>

          {items.isPending ? (
            <LoadingState label="Loading items…" />
          ) : items.error ? (
            <ErrorState
              error={items.error}
              retry={() => void items.refetch()}
            />
          ) : items.data.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              description="Add your first item above."
            />
          ) : (
            <DataTable
              caption="Items in this workspace"
              columns={columns}
              rows={items.data}
              rowKey={(item) => item.id}
            />
          )}
        </CardContent>
      </Card>

      {/* ── ai: LLM plumbing with per-call cost ───────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Ask the model</h2>
          </CardTitle>
          <CardDescription>
            Anthropic, OpenAI, Azure, OpenRouter, a local model or Claude Code —
            picked in .env. Every call is capped per workspace per day, priced,
            and recorded in the <code className="font-mono">llm_call</code>{" "}
            table.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {aiEnabled.data?.enabled ? (
            <>
              <Textarea
                aria-label="Prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => askAi.mutate({ prompt })}
                  disabled={askAi.isPending || !prompt.trim()}
                >
                  {askAi.isPending ? "Thinking…" : "Send"}
                </Button>
                {askAi.data && (
                  <p className="text-xs text-muted-foreground">
                    {askAi.data.servedBy ?? aiEnabled.data?.model}
                    {askAi.data.outputTokens !== null &&
                      ` · ${askAi.data.inputTokens}→${askAi.data.outputTokens} tokens`}
                    {" · "}
                    {askAi.data.costKnown
                      ? format.number(askAi.data.costUsd, {
                          style: "currency",
                          currency: "USD",
                          maximumFractionDigits: 6,
                        })
                      : "unpriced"}
                    {askAi.data.latencyMs !== null &&
                      ` · ${askAi.data.latencyMs}ms`}
                    {askAi.data.truncated && " · cut off at the token limit"}
                  </p>
                )}
              </div>
              <FieldError>{askAi.error?.message}</FieldError>
              {askAi.data && (
                <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
                  {askAi.data.text}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Set <code className="font-mono">LLM_MODEL</code> and its
              provider&apos;s key in .env to enable this.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── storage: upload + authenticated read-back ─────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Files</h2>
          </CardTitle>
          <CardDescription>
            Stored via <code className="font-mono">@repo/storage</code> (local
            disk today, S3 by changing one env var). Served through an
            authenticated route.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <FileDrop
            aria-label="Upload a file"
            accept="image/*,application/pdf,text/plain,text/csv"
            description="Images, PDF, plain text or CSV."
            disabled={uploading}
            label={uploading ? "Uploading…" : "Choose a file"}
            onFile={(file) => void upload(file)}
          />
          {media.data && media.data.length > 0 && (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {media.data.map((asset) => (
                <li
                  key={asset.id}
                  className="truncate rounded-md border p-2 text-xs"
                  title={asset.filename}
                >
                  <a
                    href={asset.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    {asset.filename}
                  </a>
                  <div className="text-muted-foreground">
                    {format.bytes(asset.sizeBytes)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── jobs: the worker round trip ───────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Background work</h2>
          </CardTitle>
          <CardDescription>
            Enqueues a job on Redis; the separate worker process runs it and
            records the outcome.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => queueSummary.mutate()}
              disabled={queueSummary.isPending}
            >
              {queueSummary.isPending
                ? "Queueing…"
                : "Summarise items in the worker"}
            </Button>
            <Button variant="ghost" onClick={() => void jobs.refetch()}>
              Refresh
            </Button>
          </div>
          <ul className="space-y-1 font-mono text-xs text-muted-foreground">
            {jobs.data?.length === 0 && <li>No job runs yet.</li>}
            {jobs.data?.map((run) => (
              <li key={run.id}>
                {run.status === "completed"
                  ? "✓"
                  : run.status === "failed"
                    ? "✗"
                    : "…"}{" "}
                {run.name} {run.error ? `— ${run.error}` : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
