"use client";

/**
 * Documents: add text (a .md/.txt file or pasted), see indexing status, and
 * search them — hybrid when embeddings are on, keyword-only (and says so)
 * when they are not. "Answer" asks the AI for a cited answer, or an honest
 * "the documents do not say".
 *
 * The file is read in the browser and sent as text (docs.create): no bytes
 * route, no storage round trip. Kit components only.
 */
import { useRef, useState, type FormEvent } from "react";
import { RefreshCw, Search, Trash2 } from "lucide-react";
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
import { FileDrop } from "@/components/ui/file-drop";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Doc = RouterOutputs["docs"]["list"][number];
type Hit = RouterOutputs["docs"]["search"]["hits"][number];

const MAX_CHARS = 500_000;

/** Poll while something is indexing: 1s, slowing to 10s, giving up at 3 min. */
const POLL_GIVE_UP_MS = 3 * 60_000;
function pollDelay(busyForMs: number): number | false {
  if (busyForMs > POLL_GIVE_UP_MS) return false;
  return Math.min(10_000, 1000 * 2 ** Math.floor(busyForMs / 15_000));
}

export function DocsPage() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-6">
        <AddDocument />
        <DocumentList />
      </div>
      <SearchPanel />
    </div>
  );
}

function AddDocument() {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const create = trpc.docs.create.useMutation({
    onSuccess: (doc) => {
      void utils.docs.list.invalidate();
      setTitle("");
      setText("");
      if (doc.queued)
        toast.success("Document added — indexing in the background");
      else
        toast.warning(
          "Document saved, but indexing could not be queued. Re-index it later.",
        );
    },
    onError: (err) => toast.error(err.message),
  });

  async function fromFile(file: File) {
    const content = await file.text();
    if (content.length > MAX_CHARS) {
      toast.error("That file is too large (500,000 characters max).");
      return;
    }
    create.mutate({
      title: file.name.slice(0, 200),
      content,
      contentType: /\.(md|markdown)$/i.test(file.name)
        ? "text/markdown"
        : "text/plain",
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !text.trim()) return;
    create.mutate({ title, content: text, contentType: "text/markdown" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a document</CardTitle>
        <CardDescription>
          Markdown or plain text. Headings become the sections search results
          point to.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FileDrop
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          onFile={(f) => void fromFile(f)}
          label="Choose a .md or .txt file"
          description="Or drop it here."
          disabled={create.isPending}
        />
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="doc-title">Title</Label>
            <Input
              id="doc-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="doc-text">Text</Label>
            <Textarea
              id="doc-text"
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="# A heading&#10;&#10;Paste text here."
            />
          </div>
          <Button
            type="submit"
            className="self-start"
            disabled={create.isPending || !title.trim() || !text.trim()}
          >
            Add document
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function statusBadge(doc: Doc) {
  if (doc.status === "ready")
    return (
      <Badge variant="secondary">
        {doc.chunkCount === 1 ? "1 section" : `${doc.chunkCount} sections`}
      </Badge>
    );
  if (doc.status === "failed")
    return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">indexing…</Badge>;
}

function DocumentList() {
  const format = useFormat();
  const utils = trpc.useUtils();
  // When the current stretch of "something is indexing" began (for backoff).
  const busySince = useRef<number | null>(null);
  const docs = trpc.docs.list.useQuery(undefined, {
    // Poll while the worker has something in hand, backing off; a stuck
    // document is failed by the server's sweep, and "Refresh" polls again.
    refetchInterval: (q) => {
      const busy = q.state.data?.some(
        (d) => d.status === "pending" || d.status === "indexing",
      );
      if (!busy) {
        busySince.current = null;
        return false;
      }
      busySince.current ??= Date.now();
      return pollDelay(Date.now() - busySince.current);
    },
  });
  const refresh = () => {
    busySince.current = null;
    void docs.refetch();
  };
  const done = () => void utils.docs.list.invalidate();
  const remove = trpc.docs.remove.useMutation({
    onSuccess: () => {
      done();
      toast.success("Document deleted");
    },
    onError: (err) => toast.error(err.message),
  });
  const reindex = trpc.docs.reindex.useMutation({
    onSuccess: () => {
      done();
      toast.info("Re-indexing in the background");
    },
    onError: (err) => toast.error(err.message),
  });

  let body;
  if (docs.isPending) body = <LoadingState label="Loading documents…" />;
  else if (docs.isError)
    body = <ErrorState error={docs.error} retry={() => void docs.refetch()} />;
  else if (docs.data.length === 0)
    body = (
      <EmptyState
        title="No documents yet"
        description="Add one above, then search it."
      />
    );
  else
    body = (
      <ul className="flex flex-col divide-y" aria-label="Documents">
        {docs.data.map((doc) => (
          <li key={doc.id} className="flex items-start gap-3 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{doc.title}</span>
                <span data-testid="doc-status">{statusBadge(doc)}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {format.date(doc.createdAt, "datetime")}
                {doc.embeddingModel ? ` · ${doc.embeddingModel}` : ""}
              </span>
              {doc.note ? (
                <span className="text-xs text-muted-foreground">
                  {doc.note}
                </span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Re-index "${doc.title}"`}
              disabled={reindex.isPending}
              onClick={() => reindex.mutate({ id: doc.id })}
            >
              <RefreshCw />
            </Button>
            <ConfirmDialog
              trigger={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete "${doc.title}"`}
                >
                  <Trash2 className="text-destructive" />
                </Button>
              }
              title="Delete this document?"
              description="It is removed from search for everyone in the workspace. This cannot be undone."
              confirmLabel="Delete"
              destructive
              onConfirm={() => remove.mutate({ id: doc.id })}
            />
          </li>
        ))}
      </ul>
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Documents</CardTitle>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function Snippet({ hit }: { hit: Hit }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid="search-snippet">
      {hit.snippetParts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            className="rounded-sm bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/40"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function SearchPanel() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const results = trpc.docs.search.useQuery(
    { query, limit: 8 },
    { enabled: query.length > 0 },
  );
  const answer = trpc.docs.answer.useMutation({
    onError: (err) => toast.error(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    answer.reset();
    setQuery(draft.trim());
  }

  let body = null;
  if (!query) body = null;
  else if (results.isPending) body = <LoadingState label="Searching…" />;
  else if (results.isError)
    body = (
      <ErrorState error={results.error} retry={() => void results.refetch()} />
    );
  else if (results.data.hits.length === 0)
    body = (
      <EmptyState
        icon={<Search />}
        title="No matches"
        description="Try other words, or check the document finished indexing."
      />
    );
  else
    body = (
      <ol className="flex flex-col gap-4" aria-label="Search results">
        {results.data.hits.map((hit) => (
          <li key={hit.chunkId} className="flex flex-col gap-1">
            <span className="text-sm font-medium">{hit.heading}</span>
            <Snippet hit={hit} />
            <span className="text-xs text-muted-foreground">
              matched by {hit.matchedBy.join(" + ")}
            </span>
          </li>
        ))}
      </ol>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search</CardTitle>
        <CardDescription>
          {results.data?.keywordOnly
            ? `Keyword search only (${results.data.keywordOnly}).`
            : "Keyword and meaning, combined."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form className="flex gap-2" onSubmit={submit} role="search">
          <Input
            aria-label="Search documents"
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What are you looking for?"
          />
          <Button type="submit" disabled={!draft.trim()}>
            Search
          </Button>
        </form>
        {body}
        {query && results.data && results.data.hits.length > 0 ? (
          <div className="flex flex-col gap-2 border-t pt-4">
            <Button
              variant="outline"
              className="self-start"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ question: query })}
            >
              {answer.isPending ? "Answering…" : "Answer from these documents"}
            </Button>
            {answer.data?.status === "answered" ? (
              <div className="flex flex-col gap-2 text-sm">
                <p>{answer.data.answer}</p>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {answer.data.citations.map((c) => (
                    <li key={`${c.n}-${c.chunkId}`}>
                      [{c.n}] {c.heading}: “{c.quote}”
                    </li>
                  ))}
                </ul>
              </div>
            ) : answer.data?.status === "unknown" ? (
              <p className="text-sm text-muted-foreground" role="status">
                No confident answer: {answer.data.detail}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
