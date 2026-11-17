"use client";

/**
 * Hands the server's display config (APP_LOCALE / APP_CURRENCY / APP_TIMEZONE)
 * to client components. The root layout renders this once; anything below
 * calls `useFormat()` and gets formatters that agree with the server's output,
 * so server- and client-rendered text cannot disagree (no hydration mismatch
 * from a browser in a different timezone).
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
  createFormatter,
  DEFAULT_FORMAT,
  type FormatConfig,
} from "@/lib/format";

const FormatContext = createContext<FormatConfig>(DEFAULT_FORMAT);

export function FormatProvider({
  config,
  children,
}: {
  config: FormatConfig;
  children: ReactNode;
}) {
  return (
    <FormatContext.Provider value={config}>{children}</FormatContext.Provider>
  );
}

export function useFormat() {
  const config = useContext(FormatContext);
  return useMemo(() => createFormatter(config), [config]);
}
