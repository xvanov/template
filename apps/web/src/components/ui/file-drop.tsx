"use client";

/**
 * A real <input type="file"> styled as a drop zone. Keyboard users Tab to the
 * input (visually hidden but focusable; the zone shows the focus ring) and press
 * Enter/Space to open the picker. Mouse users click or drop a file.
 *
 * Pure UI: it hands you the File. To store it, pass it to `uploadFile` from
 * `@/lib/upload`, which posts to the authenticated /api/media/upload route.
 */
import { FileUp } from "lucide-react";
import { useId, useState, type DragEvent, type ReactNode } from "react";

import { matchesAccept } from "@/lib/file-accept";
import { cn } from "@/lib/utils";

export function FileDrop({
  accept,
  onFile,
  label = "Choose a file",
  description,
  disabled = false,
  id,
  name,
  className,
  "aria-label": ariaLabel,
}: {
  /** Same syntax as the input's accept attribute, e.g. ".csv,text/csv". */
  accept?: string;
  onFile: (file: File) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const autoId = useId();
  const inputId = id ?? `file-${autoId}`;
  const descId = `${inputId}-desc`;
  const statusId = `${inputId}-status`;
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (!matchesAccept(file, accept)) {
      setError(
        `“${file.name}” is not an accepted file type${accept ? ` (${accept})` : ""}.`,
      );
      return;
    }
    setError(null);
    setFileName(file.name);
    onFile(file);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    handleFile(e.dataTransfer.files[0]);
  }

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 py-6 text-center transition-colors",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:bg-accent/50",
          dragging && "border-primary bg-accent",
        )}
      >
        <FileUp aria-hidden className="size-5 text-muted-foreground" />
        <span className="text-sm font-medium">
          {label}{" "}
          <span className="font-normal text-muted-foreground">
            or drop it here
          </span>
        </span>
        {description ? (
          <span id={descId} className="text-xs text-muted-foreground">
            {description}
          </span>
        ) : null}
        <input
          id={inputId}
          name={name}
          type="file"
          accept={accept}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={[description ? descId : null, statusId]
            .filter(Boolean)
            .join(" ")}
          className="sr-only"
          onChange={(e) => {
            handleFile(e.currentTarget.files?.[0]);
            // Allow picking the same file again after an upload.
            e.currentTarget.value = "";
          }}
        />
      </label>
      <p id={statusId} aria-live="polite" className="mt-1.5 min-h-5 text-sm">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : fileName ? (
          <span>
            Selected: <span className="font-medium">{fileName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">No file chosen</span>
        )}
      </p>
    </div>
  );
}
