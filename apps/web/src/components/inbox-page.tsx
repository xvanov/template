"use client";

/**
 * The inbox: email and texts that ARRIVED for this workspace (packages/inbound),
 * newest first, with the message open beside the list.
 *
 * Only the TEXT of an email is shown, as text (React escapes it). The HTML is
 * kept on the server and never reaches the page: rendering a stranger's HTML
 * from our own origin is a stored-XSS hole.
 */
import { useState } from "react";
import {
  Check,
  Mail,
  MessageSquare,
  Paperclip,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
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
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Show = "open" | "all";

export function InboxPage() {
  const [show, setShow] = useState<Show>("open");
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <Addresses />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <MessageList
          show={show}
          onShow={setShow}
          selected={selected}
          onSelect={setSelected}
        />
        {selected ? (
          <MessageDetail id={selected} />
        ) : (
          <Card className="hidden lg:block">
            <CardContent>
              <EmptyState
                title="No message open"
                description="Pick a message on the left to read it."
              />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Addresses() {
  const utils = trpc.useUtils();
  const addresses = trpc.inbox.addresses.useQuery();
  const create = trpc.inbox.createEmailAddress.useMutation({
    onSuccess: () => {
      void utils.inbox.addresses.invalidate();
      toast.success("Inbound address created");
    },
    onError: (err) => toast.error(err.message),
  });

  let body;
  if (addresses.isPending) body = <LoadingState label="Loading addresses…" />;
  else if (addresses.isError)
    body = (
      <ErrorState
        error={addresses.error}
        retry={() => void addresses.refetch()}
      />
    );
  else {
    const a = addresses.data;
    body = (
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Email</dt>
          <dd>
            {a.email ? (
              <code className="break-all" data-testid="inbound-address">
                {a.email}
              </code>
            ) : a.emailEnabled ? (
              <Button
                size="sm"
                variant="outline"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                Create an inbound address
              </Button>
            ) : (
              <span className="text-muted-foreground">
                Not set up (INBOUND_EMAIL_DOMAIN is unset).
              </span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Text messages</dt>
          <dd>
            {a.sms ? (
              <span>
                Replies to texts sent from <code>{a.sms}</code>
              </span>
            ) : (
              <span className="text-muted-foreground">SMS is off.</span>
            )}
          </dd>
        </div>
      </dl>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inbox</CardTitle>
        <CardDescription>
          Email sent to this workspace&apos;s address, and replies to its texts.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function ChannelIcon({ channel }: { channel: string }) {
  return channel === "sms" ? (
    <MessageSquare aria-label="Text message" className="size-4 shrink-0" />
  ) : (
    <Mail aria-label="Email" className="size-4 shrink-0" />
  );
}

function MessageList({
  show,
  onShow,
  selected,
  onSelect,
}: {
  show: Show;
  onShow: (s: Show) => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const format = useFormat();
  const list = trpc.inbox.list.useQuery(
    { show, limit: 50 },
    {
      // The worker finishes a message within seconds of it arriving; new
      // mail is picked up every 30s (and on window focus, and "Refresh").
      refetchInterval: (q) =>
        q.state.data?.some((m) => m.status === "received") ? 3000 : 30_000,
    },
  );

  let body;
  if (list.isPending) body = <LoadingState label="Loading messages…" />;
  else if (list.isError)
    body = <ErrorState error={list.error} retry={() => void list.refetch()} />;
  else if (list.data.length === 0)
    body = (
      <EmptyState
        title={show === "open" ? "Nothing to handle" : "No messages yet"}
        description="Messages sent to the addresses above appear here."
      />
    );
  else
    body = (
      <ul className="flex flex-col divide-y" aria-label="Messages">
        {list.data.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(m.id)}
              aria-current={selected === m.id ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-1 rounded-md px-2 py-3 text-left hover:bg-muted/60",
                selected === m.id && "bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <ChannelIcon channel={m.channel} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {m.fromAddress}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {format.date(m.createdAt, "datetime")}
                </span>
              </span>
              <span className="truncate text-sm">
                {m.subject ??
                  (m.channel === "sms" ? "Text message" : "(no subject)")}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">
                  {m.status === "received"
                    ? "Arriving…"
                    : m.status === "failed"
                      ? "Could not be processed"
                      : (m.snippet ?? "")}
                </span>
                {m.attachmentCount > 0 ? (
                  <Paperclip aria-label="Has attachments" className="size-3" />
                ) : null}
                {m.handledAt ? (
                  <Badge variant="secondary">handled</Badge>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <Tabs value={show} onValueChange={(v) => onShow(v as Show)}>
            <TabsList>
              <TabsTrigger value="open">Open</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
          >
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function MessageDetail({ id }: { id: string }) {
  const format = useFormat();
  const utils = trpc.useUtils();
  const msg = trpc.inbox.get.useQuery(
    { id },
    {
      refetchInterval: (q) =>
        q.state.data?.status === "received" ? 3000 : false,
    },
  );
  const setHandled = trpc.inbox.setHandled.useMutation({
    onSuccess: (r) => {
      void utils.inbox.list.invalidate();
      void utils.inbox.get.invalidate({ id });
      toast.success(r.handled ? "Marked as handled" : "Moved back to open");
    },
    onError: (err) => toast.error(err.message),
  });

  if (msg.isPending)
    return (
      <Card>
        <CardContent>
          <LoadingState label="Opening message…" />
        </CardContent>
      </Card>
    );
  if (msg.isError)
    return (
      <Card>
        <CardContent>
          <ErrorState error={msg.error} retry={() => void msg.refetch()} />
        </CardContent>
      </Card>
    );

  const m = msg.data;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="break-words">
              {m.subject ??
                (m.channel === "sms" ? "Text message" : "(no subject)")}
            </CardTitle>
            <CardDescription className="break-all">
              From {m.fromAddress} to {m.toAddress} ·{" "}
              {format.date(m.createdAt, "datetime")}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant={m.handledAt ? "outline" : "default"}
            disabled={setHandled.isPending}
            onClick={() => setHandled.mutate({ id, handled: !m.handledAt })}
          >
            {m.handledAt ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
            {m.handledAt ? "Reopen" : "Mark handled"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {m.replyToOutbound ? (
          <p className="text-sm text-muted-foreground">
            In reply to{" "}
            <span className="text-foreground">
              {m.replyToOutbound.subject ?? m.replyToOutbound.purpose}
            </span>{" "}
            sent to {m.replyToOutbound.recipient} on{" "}
            {format.date(m.replyToOutbound.createdAt, "datetime")}
          </p>
        ) : null}
        {m.status === "received" ? (
          <LoadingState label="This message is still being processed…" />
        ) : m.status === "failed" ? (
          <ErrorState
            title="This message could not be processed"
            error={new Error(m.error ?? "Unknown error")}
          />
        ) : (
          <div
            className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm"
            data-testid="inbound-text"
          >
            {m.text?.trim() ||
              (m.hasHtml
                ? "(This email has only formatted content, which is not shown.)"
                : "(empty)")}
          </div>
        )}
        {m.attachments.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Attachments">
            {m.attachments.map((a, i) => (
              <li key={i} className="flex items-center gap-2">
                <Paperclip aria-hidden className="size-3.5 shrink-0" />
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate underline underline-offset-2"
                  >
                    {a.filename}
                  </a>
                ) : (
                  <span className="truncate">{a.filename}</span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {format.bytes(a.sizeBytes)}
                  {a.skipped ? ` · not stored: ${a.skipped}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {m.handledAt ? (
          <p className="text-xs text-muted-foreground">
            Handled {format.date(m.handledAt, "datetime")}
            {m.handledBy ? ` by ${m.handledBy.name}` : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
