"use client";

/**
 * The "hello world" that proves the whole stack is alive: one screen touching
 * auth, the tenant, the database, the typed API, the LLM, blob storage and the
 * background worker. It is also what the smoke gate drives.
 */
import { useRef, useState } from "react";
import { authClient } from "@repo/auth/client";

import { trpc } from "@/lib/trpc";
import {
  Button,
  Card,
  CardTitle,
  ErrorText,
  Hint,
  Input,
  Textarea,
} from "./ui";

export function Dashboard({ user }: { user: { name: string; email: string } }) {
  const org = trpc.org.current.useQuery();
  const items = trpc.items.list.useQuery({ includeDone: true, limit: 50 });
  const aiEnabled = trpc.ai.enabled.useQuery();
  const media = trpc.media.list.useQuery({ limit: 12 });
  const jobs = trpc.items.recentJobs.useQuery();

  const invalidateItems = () => void items.refetch();

  const create = trpc.items.create.useMutation({ onSuccess: invalidateItems });
  const setDone = trpc.items.setDone.useMutation({
    onSuccess: invalidateItems,
  });
  const remove = trpc.items.remove.useMutation({ onSuccess: invalidateItems });
  const queueSummary = trpc.items.queueSummary.useMutation({
    onSuccess: () => {
      // The worker writes the outcome asynchronously; poll once after a beat.
      setTimeout(() => void jobs.refetch(), 1500);
    },
  });
  const askAi = trpc.ai.ask.useMutation();

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("Give me one tip for shipping faster.");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/media/upload", { method: "POST", body });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Upload failed (${res.status})`);
      }
      await media.refetch();
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-5 px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {org.data?.organization?.name ?? "Workspace"}
          </h1>
          <Hint>
            {user.email} · {org.data?.myRole ?? "member"}
          </Hint>
        </div>
        <Button
          variant="secondary"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign("/");
          }}
        >
          Sign out
        </Button>
      </header>

      {/* ── items: the database + typed API round trip ────────────────── */}
      <Card>
        <CardTitle>Items</CardTitle>
        <Hint>
          Scoped to this workspace. Another tenant cannot see these rows.
        </Hint>

        <form
          className="mt-4 flex gap-2"
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
        <ErrorText>{create.error?.message}</ErrorText>

        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {items.isPending && (
            <li className="py-3 text-sm text-[var(--color-muted)]">Loading…</li>
          )}
          {items.data?.length === 0 && (
            <li className="py-3 text-sm text-[var(--color-muted)]">
              Nothing yet — add your first item above.
            </li>
          )}
          {items.data?.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              <input
                type="checkbox"
                checked={item.done}
                // The accessible name stays constant; the checked state carries
                // the status. A name that flips with state re-labels the control
                // out from under assistive tech (and under any test) mid-click.
                aria-label={`Toggle "${item.title}"`}
                onChange={(e) =>
                  setDone.mutate({ id: item.id, done: e.target.checked })
                }
                className="size-4 accent-[var(--color-accent)]"
              />
              <span
                className={
                  item.done
                    ? "flex-1 text-[var(--color-muted)] line-through"
                    : "flex-1"
                }
              >
                {item.title}
              </span>
              <Button
                variant="danger"
                aria-label={`Delete "${item.title}"`}
                onClick={() => remove.mutate({ id: item.id })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── ai: LLM plumbing with per-call cost ───────────────────────── */}
      <Card>
        <CardTitle>Ask the model</CardTitle>
        {aiEnabled.data?.enabled ? (
          <>
            <Textarea
              aria-label="Prompt"
              rows={3}
              className="mt-3"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-3">
              <Button
                onClick={() => askAi.mutate({ prompt })}
                disabled={askAi.isPending || !prompt.trim()}
              >
                {askAi.isPending ? "Thinking…" : "Send"}
              </Button>
              {askAi.data && (
                <Hint className="text-xs">
                  {askAi.data.inputTokens}→{askAi.data.outputTokens} tokens · $
                  {askAi.data.costUsd.toFixed(6)} · {askAi.data.latencyMs}ms
                </Hint>
              )}
            </div>
            <ErrorText>{askAi.error?.message}</ErrorText>
            {askAi.data && (
              <p className="mt-3 rounded-lg bg-[var(--color-bg)] p-3 text-sm whitespace-pre-wrap">
                {askAi.data.text}
              </p>
            )}
          </>
        ) : (
          <Hint className="mt-2">
            Set <code className="font-mono">LLM_API_KEY</code> in .env to enable
            this. Every call is priced and recorded in the{" "}
            <code className="font-mono">llm_call</code> table.
          </Hint>
        )}
      </Card>

      {/* ── storage: upload + authenticated read-back ─────────────────── */}
      <Card>
        <CardTitle>Files</CardTitle>
        <Hint>
          Stored via <code className="font-mono">@repo/storage</code> (local
          disk today, S3 by changing one env var). Served through an
          authenticated route.
        </Hint>
        <input
          ref={fileInput}
          type="file"
          aria-label="Upload a file"
          accept="image/*,application/pdf,text/plain,text/csv"
          disabled={uploading}
          className="mt-3 block w-full text-sm"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <ErrorText>{uploadError}</ErrorText>
        {media.data && media.data.length > 0 && (
          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {media.data.map((asset) => (
              <li
                key={asset.id}
                className="truncate rounded-lg border border-[var(--color-border)] p-2 text-xs"
                title={asset.filename}
              >
                <a
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {asset.filename}
                </a>
                <div className="text-[var(--color-muted)]">
                  {Math.max(1, Math.round(asset.sizeBytes / 1024))} KB
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ── jobs: the worker round trip ───────────────────────────────── */}
      <Card>
        <CardTitle>Background work</CardTitle>
        <Hint>
          Enqueues a job on Redis; the separate worker process runs it and
          records the outcome.
        </Hint>
        <div className="mt-3 flex items-center gap-3">
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
        <ErrorText>{queueSummary.error?.message}</ErrorText>
        <ul className="mt-3 space-y-1 font-mono text-xs text-[var(--color-muted)]">
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
      </Card>
    </main>
  );
}
