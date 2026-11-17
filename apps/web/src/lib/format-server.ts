/** Server-only: reads env(). Client code uses useFormat() instead. */
import { env } from "@repo/env";

import { createFormatter, type FormatConfig } from "./format";

/** The app's display config, from APP_LOCALE / APP_CURRENCY / APP_TIMEZONE. */
export function formatConfig(): FormatConfig {
  const e = env();
  return {
    locale: e.APP_LOCALE,
    currency: e.APP_CURRENCY,
    timeZone: e.APP_TIMEZONE,
  };
}

/** Formatters bound to the app's config, for server components. */
export function getFormatter() {
  return createFormatter(formatConfig());
}
