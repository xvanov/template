/**
 * Pure display formatters. No React, no I/O — safe on server and client and
 * covered by format.test.ts.
 *
 * Locale, currency and timezone are configuration, not constants: every
 * function takes an optional `FormatConfig` (missing fields fall back to
 * DEFAULT_FORMAT). In the app you rarely pass it by hand —
 *   - Server components: `getFormatter()` from `@/lib/format-server` (reads
 *     APP_LOCALE / APP_CURRENCY / APP_TIMEZONE through env()).
 *   - Client components: `useFormat()` from `@/components/format-provider`
 *     (the /app layout passes the same server config down; outside /app it
 *     falls back to DEFAULT_FORMAT, because the root layout is static).
 *
 * Conventions:
 *   - Money is integer MINOR units (cents for USD, yen for JPY — the currency's
 *     own number of decimals is used), never floats.
 *   - A calendar date "YYYY-MM-DD" is a date, not UTC midnight: it never shifts
 *     by a day whatever the timezone.
 */

export type FormatConfig = {
  /** BCP 47 locale tag, e.g. "en-US", "de-DE". */
  locale: string;
  /** ISO 4217 currency code, e.g. "USD", "EUR", "JPY". */
  currency: string;
  /** IANA timezone, e.g. "UTC", "America/New_York". */
  timeZone: string;
};

export const DEFAULT_FORMAT: FormatConfig = {
  locale: "en-US",
  currency: "USD",
  timeZone: "UTC",
};

/** U+2212 MINUS SIGN — typographically correct and distinct from a hyphen. */
export const MINUS = "−";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function resolve(config?: Partial<FormatConfig>): FormatConfig {
  return { ...DEFAULT_FORMAT, ...config };
}

/** Intl objects are expensive to build; cache them by their options. */
const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(
  locale: string,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = locale + JSON.stringify(options);
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = new Intl.NumberFormat(locale, options)));
  return f;
}

/** Newer ICU emits narrow/no-break spaces (before AM/PM, around "€"); normalise. */
function normaliseSpaces(s: string): string {
  return s.replace(/[  ]/g, " ");
}

// ── numbers & money ─────────────────────────────────────────────────────────

/** Decimal digits of the currency's minor unit: USD 2, JPY 0, KWD 3. */
export function currencyDigits(currency: string): number {
  return (
    numberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

export type MoneyOptions = {
  /** Prefix positive amounts with "+" (negative amounts always get "−"). */
  signed?: boolean;
  /** "$950", "$12.5K", "$1.2M" — for dense summaries, never for ledgers. */
  compact?: boolean;
};

/** Format an amount in integer minor units (cents) in the configured currency. */
export function formatMoney(
  minorUnits: number,
  options: MoneyOptions = {},
  config?: Partial<FormatConfig>,
): string {
  const { locale, currency } = resolve(config);
  const { signed = false, compact = false } = options;
  const digits = currencyDigits(currency);
  const abs = Math.abs(minorUnits) / 10 ** digits;
  const fmt = numberFormat(
    locale,
    compact
      ? {
          style: "currency",
          currency,
          notation: "compact",
          minimumFractionDigits: 0,
          maximumFractionDigits: 1,
        }
      : {
          style: "currency",
          currency,
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        },
  );
  const body = normaliseSpaces(fmt.format(abs));
  // Rounding can turn -0.4 cents into "$0.00": never print "−$0.00".
  const isZero = !/[1-9]/.test(body);
  if (minorUnits < 0 && !isZero) return `${MINUS}${body}`;
  if (signed && minorUnits > 0 && !isZero) return `+${body}`;
  return body;
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  config?: Partial<FormatConfig>,
): string {
  return normaliseSpaces(
    numberFormat(resolve(config).locale, options).format(value),
  );
}

/** 0.125 → "12.5%". `fraction` is a ratio, not a percentage. */
export function formatPercent(
  fraction: number,
  maximumFractionDigits = 1,
  config?: Partial<FormatConfig>,
): string {
  return formatNumber(
    fraction,
    { style: "percent", maximumFractionDigits },
    config,
  );
}

/**
 * "1 item", "3 items", "1,200 transactions" — the number is localised; the
 * words are whatever you pass (English plural by default).
 */
export function formatCount(
  n: number,
  singular: string,
  pluralForm?: string,
  config?: Partial<FormatConfig>,
): string {
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${formatNumber(n, {}, config)} ${word}`;
}

/** 1536 → "1.5 KB". Binary (1024) steps, the unit people expect for files. */
export function formatBytes(
  bytes: number,
  config?: Partial<FormatConfig>,
): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${formatNumber(value, { maximumFractionDigits: i === 0 ? 0 : 1 }, config)} ${units[i]}`;
}

// ── dates ───────────────────────────────────────────────────────────────────

export type DateInput = Date | string | number;

function isDateOnly(value: DateInput): value is string {
  return typeof value === "string" && DATE_ONLY.test(value);
}

export function toDate(value: DateInput): Date {
  if (value instanceof Date) return value;
  if (isDateOnly(value)) return new Date(`${value}T00:00:00Z`);
  return new Date(value);
}

export type DateStyle = "date" | "short" | "long" | "datetime" | "time";

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { month: "short", day: "numeric", year: "numeric" },
  short: { month: "short", day: "numeric" },
  long: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
  datetime: {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  time: { hour: "numeric", minute: "2-digit" },
};

/**
 * Format an instant (or a calendar date) in the configured timezone. en-US:
 * - date      "Mar 7, 2026"
 * - short     "Mar 7"
 * - long      "Saturday, March 7, 2026"
 * - datetime  "Mar 7, 2026, 11:30 PM"
 * - time      "11:30 PM"
 */
export function formatDate(
  value: DateInput,
  style: DateStyle = "date",
  config?: Partial<FormatConfig>,
): string {
  const { locale, timeZone } = resolve(config);
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  // A bare calendar date has no time of day: render it as-is, in UTC.
  const tz = isDateOnly(value) ? "UTC" : timeZone;
  return normaliseSpaces(
    new Intl.DateTimeFormat(locale, {
      ...DATE_STYLES[style],
      timeZone: tz,
    }).format(date),
  );
}

/** The calendar date ("YYYY-MM-DD") an instant falls on in the configured timezone. */
export function toCalendarDate(
  value: DateInput,
  config?: Partial<FormatConfig>,
): string {
  if (isDateOnly(value)) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: resolve(config).timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(toDate(value));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function calendarToUtcMs(iso: string): number {
  const day = iso.slice(0, 10);
  if (!DATE_ONLY.test(day)) throw new Error(`Not a calendar date: ${iso}`);
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Whole calendar days from `todayIso` to `isoDate` (both "YYYY-MM-DD"; a longer
 * ISO string is truncated to its date part). Positive = in the future.
 */
export function daysUntil(isoDate: string, todayIso: string): number {
  return Math.round(
    (calendarToUtcMs(isoDate) - calendarToUtcMs(todayIso)) / DAY_MS,
  );
}

/**
 * Calendar-day phrasing relative to `now`, evaluated in the configured
 * timezone and worded in its locale (en-US: "today", "tomorrow", "in 3 days",
 * "2 weeks ago", "4 months ago").
 */
export function formatRelative(
  value: DateInput,
  now: DateInput,
  config?: Partial<FormatConfig>,
): string {
  const days = daysUntil(
    toCalendarDate(value, config),
    toCalendarDate(now, config),
  );
  const rtf = new Intl.RelativeTimeFormat(resolve(config).locale, {
    numeric: "auto",
  });
  const abs = Math.abs(days);
  const sign = days < 0 ? -1 : 1;
  if (abs < 14) return rtf.format(days, "day");
  if (abs < 60) return rtf.format(sign * Math.round(abs / 7), "week");
  if (abs < 730) return rtf.format(sign * Math.round(abs / 30.44), "month");
  return rtf.format(sign * Math.round(abs / 365.25), "year");
}

/**
 * Elapsed wall-clock time, for freshness: "just now", "12 minutes ago",
 * "3 hours ago", "3 days ago" (or "in 5 minutes" for future instants).
 */
export function formatElapsed(
  value: DateInput,
  now: DateInput,
  config?: Partial<FormatConfig>,
): string {
  const diffMs = toDate(value).getTime() - toDate(now).getTime();
  const minutes = Math.trunc(diffMs / 60_000);
  if (minutes === 0) return "just now";
  const rtf = new Intl.RelativeTimeFormat(resolve(config).locale, {
    numeric: "always",
  });
  const abs = Math.abs(minutes);
  if (abs < 60) return rtf.format(minutes, "minute");
  if (abs < 60 * 24) return rtf.format(Math.trunc(minutes / 60), "hour");
  return rtf.format(Math.trunc(minutes / (60 * 24)), "day");
}

// ── bound formatter ─────────────────────────────────────────────────────────

/** Every formatter with the config already applied — what useFormat() returns. */
export function createFormatter(config?: Partial<FormatConfig>) {
  const c = resolve(config);
  return {
    config: c,
    money: (minor: number, options?: MoneyOptions) =>
      formatMoney(minor, options, c),
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      formatNumber(value, options, c),
    percent: (fraction: number, digits?: number) =>
      formatPercent(fraction, digits, c),
    count: (n: number, singular: string, pluralForm?: string) =>
      formatCount(n, singular, pluralForm, c),
    bytes: (bytes: number) => formatBytes(bytes, c),
    date: (value: DateInput, style?: DateStyle) => formatDate(value, style, c),
    relative: (value: DateInput, now: DateInput = new Date()) =>
      formatRelative(value, now, c),
    elapsed: (value: DateInput, now: DateInput = new Date()) =>
      formatElapsed(value, now, c),
    today: (now: DateInput = new Date()) => toCalendarDate(now, c),
  };
}

export type Formatter = ReturnType<typeof createFormatter>;
