/**
 * The five primitives the whole app is built from. Deliberately tiny — no
 * component library to upgrade, and the class strings stay readable. Add
 * shadcn/ui later if a real design system is needed.
 */
import type { ComponentProps } from "react";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cx(
        "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cx(
        "mb-1 text-sm font-semibold tracking-wide uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function Hint({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cx("text-sm text-[var(--color-muted)]", className)}
      {...props}
    />
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary:
      "bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90",
    secondary:
      "border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-bg)]",
    ghost: "hover:bg-[var(--color-border)]/40",
    danger: "text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10",
  } as const;
  return (
    <button className={cx(base, variants[variant], className)} {...props} />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm",
        "placeholder:text-[var(--color-muted)]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cx(
        "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm",
        "placeholder:text-[var(--color-muted)]",
        className,
      )}
      {...props}
    />
  );
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-[var(--color-danger)]">
      {children}
    </p>
  );
}
