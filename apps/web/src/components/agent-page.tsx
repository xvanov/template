"use client";

/**
 * Agents: start a run on a goal, watch runs and their step-by-step trace, and
 * work the approval queue — every change an agent (or an MCP client without
 * write access) wants to make waits here for a person.
 *
 * Built from the kit. Runs execute in the worker; this page polls while any
 * run is queued or running.
 */
import { useState } from "react";
import { Bot, Check, Pencil, X } from "lucide-react";
import { toast } from "sonner";

import { ApiKeysPanel } from "@/components/api-keys-panel";
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
import {
  EmptyState,
  ErrorState,
  FieldError,
  LoadingState,
} from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Run = RouterOutputs["agent"]["runs"][number];
type Proposal = RouterOutputs["agent"]["proposals"][number];
type Step = RouterOutputs["agent"]["run"]["steps"][number];

const ACTIVE = new Set(["queued", "running"]);

function statusVariant(status: string) {
  if (status === "completed" || status === "applied") return "default";
  if (status === "failed") return "destructive";
  if (ACTIVE.has(status) || status === "pending") return "secondary";
  return "outline";
}

export function AgentPage() {
  const utils = trpc.useUtils();
  const org = trpc.org.current.useQuery();
  const aiEnabled = trpc.ai.enabled.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const runs = trpc.agent.runs.useQuery(undefined, {
    refetchInterval: (q) =>
      q.state.data?.some((r) => ACTIVE.has(r.status)) ? 2000 : false,
  });
  const proposals = trpc.agent.proposals.useQuery(undefined, {
    refetchInterval: () =>
      runs.data?.some((r) => ACTIVE.has(r.status)) ? 2000 : false,
  });

  const [goal, setGoal] = useState("");
  const start = trpc.agent.start.useMutation({
    onSuccess: (run) => {
      setGoal("");
      setSelected(run.id);
      toast.info("Run queued — the worker will pick it up.");
      void utils.agent.runs.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const isAdmin = ["owner", "admin"].some((r) =>
    (org.data?.myRole ?? "")
      .split(",")
      .map((x) => x.trim())
      .includes(r),
  );

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
        <p className="text-sm text-muted-foreground">
          Give the agent a goal. It looks things up on its own; anything it
          wants to change waits for your approval below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Start a run</h2>
          </CardTitle>
          <CardDescription>
            Runs in the background worker, bounded in steps and spend.
            {aiEnabled.data && !aiEnabled.data.enabled
              ? " AI is not configured, so a run will stop straight away and say why."
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (goal.trim()) start.mutate({ goal: goal.trim() });
            }}
          >
            <Textarea
              aria-label="Goal"
              rows={3}
              placeholder="e.g. Find duplicate items and propose deleting the extras."
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <Button type="submit" disabled={start.isPending || !goal.trim()}>
              <Bot aria-hidden />
              {start.isPending ? "Starting…" : "Start run"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Approval queue</h2>
          </CardTitle>
          <CardDescription>
            Nothing here has happened yet. Approve to apply it (you can edit the
            input first), or reject it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {proposals.isPending ? (
            <LoadingState label="Loading proposals…" />
          ) : proposals.error ? (
            <ErrorState
              error={proposals.error}
              retry={() => void proposals.refetch()}
            />
          ) : proposals.data.length === 0 ? (
            <EmptyState
              title="Nothing waiting for approval"
              description="Changes an agent proposes appear here."
            />
          ) : (
            <ul className="space-y-3">
              {proposals.data.map((p) => (
                <ProposalCard key={p.id} proposal={p} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Runs</h2>
          </CardTitle>
          <CardDescription>Select a run to see its trace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runs.isPending ? (
            <LoadingState label="Loading runs…" />
          ) : runs.error ? (
            <ErrorState error={runs.error} retry={() => void runs.refetch()} />
          ) : runs.data.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Start one above."
              icon={<Bot />}
            />
          ) : (
            <ul className="divide-y rounded-md border">
              {runs.data.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  selected={selected === r.id}
                  onSelect={() => setSelected(selected === r.id ? null : r.id)}
                />
              ))}
            </ul>
          )}
          {selected ? <RunTrace id={selected} /> : null}
        </CardContent>
      </Card>

      {isAdmin ? <ApiKeysPanel /> : null}
    </>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: Run;
  selected: boolean;
  onSelect: () => void;
}) {
  const format = useFormat();
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className={cn(
          "flex w-full flex-col gap-1 px-3 py-2 text-left text-sm hover:bg-accent",
          selected && "bg-accent",
        )}
      >
        <span className="flex items-center gap-2">
          <Badge variant={statusVariant(run.status)} data-testid="run-status">
            {run.status}
          </Badge>
          <span className="truncate font-medium">{run.goal}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {format.date(run.createdAt, "datetime")} · {run.turns} turn
          {run.turns === 1 ? "" : "s"} ·{" "}
          {format.number(run.costUsd, {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 4,
          })}
          {run.error ? ` · ${run.error}` : ""}
        </span>
      </button>
    </li>
  );
}

function RunTrace({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const run = trpc.agent.run.useQuery(
    { id },
    {
      refetchInterval: (q) =>
        q.state.data && ACTIVE.has(q.state.data.status) ? 2000 : false,
    },
  );
  const cancel = trpc.agent.cancel.useMutation({
    onSuccess: () => {
      toast.info("Cancelling…");
      void utils.agent.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  if (run.isPending) return <LoadingState label="Loading the trace…" />;
  if (run.error)
    return <ErrorState error={run.error} retry={() => void run.refetch()} />;
  const r = run.data;
  return (
    <section aria-label="Run trace" className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
        {r.stopReason ? (
          <span className="text-xs text-muted-foreground">
            stopped: {r.stopReason}
          </span>
        ) : null}
        {r.model ? (
          <span className="font-mono text-xs text-muted-foreground">
            {r.model}
          </span>
        ) : null}
        {ACTIVE.has(r.status) && !r.cancelRequestedAt ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => cancel.mutate({ id })}
            disabled={cancel.isPending}
          >
            Cancel run
          </Button>
        ) : null}
      </div>
      <p className="text-sm">
        <span className="font-medium">Goal:</span> {r.goal}
      </p>
      {r.error ? <FieldError>{r.error}</FieldError> : null}
      {r.result ? (
        <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">
          {r.result}
        </p>
      ) : null}
      {r.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {ACTIVE.has(r.status) ? "Waiting for the first step…" : "No steps."}
        </p>
      ) : (
        <ol className="space-y-2">
          {r.steps.map((s) => (
            <StepRow key={s.index} step={s} />
          ))}
        </ol>
      )}
    </section>
  );
}

function StepRow({ step }: { step: Step }) {
  const p = step.payload as Record<string, unknown>;
  const label =
    step.kind === "model"
      ? "Model"
      : step.kind === "tool_call"
        ? `Call ${String(p.name)}`
        : step.kind === "tool_result"
          ? `Result of ${String(p.name)}${p.isError ? " (error)" : ""}`
          : "Proposal queued";
  const body =
    step.kind === "model"
      ? String(p.text ?? "") ||
        (Array.isArray(p.toolCalls) && p.toolCalls.length
          ? "(calls tools)"
          : "")
      : step.kind === "tool_call"
        ? JSON.stringify(p.input)
        : step.kind === "tool_result"
          ? String(p.content ?? "")
          : String(p.summary ?? "");
  return (
    <li className="text-sm">
      <p className="text-xs font-medium text-muted-foreground">
        {step.index + 1}. {label}
        {step.kind === "model"
          ? ` · ${step.inputTokens}→${step.outputTokens} tokens`
          : ""}
      </p>
      {body ? (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
          {body}
        </pre>
      ) : null}
    </li>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const utils = trpc.useUtils();
  const format = useFormat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(proposal.input, null, 2),
  );
  const [draftError, setDraftError] = useState<string | null>(null);
  const done = () => void utils.agent.invalidate();

  const approve = trpc.agent.approve.useMutation({
    onSuccess: (r) => {
      if (r.status === "applied") toast.success("Applied");
      else toast.error(`Not applied: ${r.error}`);
      done();
    },
    onError: (err) => toast.error(err.message),
  });
  const reject = trpc.agent.reject.useMutation({
    onSuccess: () => {
      toast.success("Rejected");
      done();
    },
    onError: (err) => toast.error(err.message),
  });
  const busy = approve.isPending || reject.isPending;

  function onApprove() {
    if (!editing) return approve.mutate({ id: proposal.id });
    let input: unknown;
    try {
      input = JSON.parse(draft);
    } catch {
      setDraftError("The input is not valid JSON.");
      return;
    }
    setDraftError(null);
    approve.mutate({ id: proposal.id, input });
  }

  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{proposal.summary}</span>
        <Badge variant="outline" className="font-mono">
          {proposal.tool}
        </Badge>
        <span className="text-xs text-muted-foreground">
          from {proposal.source} · {format.date(proposal.createdAt, "datetime")}
        </span>
      </div>
      {editing ? (
        <>
          <Textarea
            aria-label={`Input for "${proposal.summary}"`}
            className="font-mono text-xs"
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <FieldError>{draftError ?? approve.error?.message}</FieldError>
        </>
      ) : (
        <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs">
          {JSON.stringify(proposal.input, null, 2)}
        </pre>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={onApprove}
          disabled={busy}
          aria-label={`Approve "${proposal.summary}"`}
        >
          <Check aria-hidden />
          {editing ? "Approve edited" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing((e) => !e)}
          disabled={busy}
          aria-pressed={editing}
        >
          <Pencil aria-hidden />
          {editing ? "Stop editing" : "Edit"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => reject.mutate({ id: proposal.id })}
          disabled={busy}
          aria-label={`Reject "${proposal.summary}"`}
        >
          <X aria-hidden />
          Reject
        </Button>
      </div>
    </li>
  );
}
