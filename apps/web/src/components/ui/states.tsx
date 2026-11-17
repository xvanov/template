/**
 * Loading / empty / error states. Every list or query-backed panel should render
 * one of these instead of a hand-rolled "Loading…" paragraph, so the three
 * states look and announce themselves the same everywhere.
 *
 * Server-compatible (no hooks). `ErrorState.retry` is a function, so pass it
 * from a client component.
 */
import { CircleAlert, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

export { errorMessage };

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 rounded-md border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <span aria-hidden className="mb-1 text-muted-foreground [&_svg]:size-6">
        {icon ?? <Inbox />}
      </span>
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Couldn’t load this",
  error,
  retry,
  className,
}: {
  title?: ReactNode;
  error: unknown;
  retry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3",
        className,
      )}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <CircleAlert aria-hidden className="size-4 shrink-0" />
        {title}
      </p>
      <p className="text-sm">{errorMessage(error)}</p>
      {retry ? (
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw aria-hidden />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingState({
  label = "Loading…",
  rows = 3,
  className,
}: {
  label?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("space-y-2", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-4", i % 3 === 2 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/** One-line inline error under a form or control. Renders nothing when empty. */
export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
