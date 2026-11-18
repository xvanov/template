import { useMemo } from "react";

/**
 * Dates as the PHONE's locale and timezone write them (the web app formats
 * with the server's APP_LOCALE/APP_TIMEZONE; on a phone the user's own
 * settings are the right answer). One formatter, not ad hoc toLocaleString.
 */
export function useFormatDate(): (d: Date | string) => string {
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return (d) => f.format(typeof d === "string" ? new Date(d) : d);
  }, []);
}
