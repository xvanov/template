/**
 * Validated server environment.
 *
 * Import `env()` — never `process.env` — anywhere on the server. Validation is
 * lazy (first call) so that merely importing this module from a client bundle
 * or a build step cannot crash; and it is cached so the cost is paid once.
 *
 * A missing or malformed variable fails here with a readable list, instead of
 * surfacing 400 lines deeper as an undefined connection string.
 */
import { z } from "zod";

/**
 * A boolean env var: "true"/"1" or "false"/"0" (any case); blank or absent =
 * `fallback`. Anything else FAILS rather than quietly meaning false: with a
 * loose parser `REQUIRE_EMAIL_VERIFICATION=yes` would switch verification OFF.
 */
function bool(fallback: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx) => {
      const b = v === undefined ? null : parseBool(v);
      if (b === undefined) {
        ctx.addIssue({ code: "custom", message: BOOL_HINT(v) });
        return z.NEVER;
      }
      return b ?? fallback;
    });
}

const BOOL_HINT = (v: unknown) =>
  `must be "true"/"1" or "false"/"0" (got ${JSON.stringify(v)})`;

/** true/false; null for blank; undefined for anything unrecognised. */
function parseBool(v: boolean | string): boolean | null | undefined {
  if (typeof v === "boolean") return v;
  const s = v.trim().toLowerCase();
  if (s === "") return null;
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

/** `VAR=` in a .env file means "unset", not "the empty string". */
const blankIsUnset = (v: unknown) => (v === "" ? undefined : v);

/** An optional URL where `VAR=` (blank) means unset instead of "invalid URL". */
const optionalUrl = z.preprocess(blankIsUnset, z.string().url().optional());

/** A base64 string that decodes to exactly 32 bytes (an AES-256 key). */
const base64Key = z
  .string()
  .refine(
    (v) => Buffer.from(v, "base64").length === 32,
    "must be base64 of exactly 32 bytes (openssl rand -base64 32)",
  );

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_URL: z.string().url().default("http://localhost:3200"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  /** Jobs the worker runs in parallel. Bounded so a typo cannot fork-bomb Redis. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

  BETTER_AUTH_SECRET: z
    .string()
    .min(
      32,
      "BETTER_AUTH_SECRET must be at least 32 chars (openssl rand -base64 32)",
    ),
  BETTER_AUTH_URL: optionalUrl,

  /**
   * Extra origins allowed to complete an auth round trip, comma-separated.
   * Needed whenever the app is reachable on an origin other than APP_URL — a
   * Cloudflare tunnel, a preview deploy, a LAN address for phone testing.
   * Kept explicit rather than wildcarded: this list is a CSRF boundary.
   */
  TRUSTED_ORIGINS: z.string().optional(),

  /**
   * Require a confirmed email address before a password sign-in succeeds.
   *
   * ON by default: it is the only thing stopping someone from signing up as
   * somebody else's address. Turn it off only for a throwaway environment.
   */
  REQUIRE_EMAIL_VERIFICATION: bool(true),

  // SMTP. Unset SMTP_HOST = mail is logged to the console instead of sent, so a
  // fresh clone runs with no mail infrastructure. `docker compose up -d mailpit`
  // gives you a real local SMTP server and inbox.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1035),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("App Template <no-reply@localhost>"),

  /**
   * URL of a local dev mail inbox (Mailpit). When set, the "confirm your email"
   * screen links straight to it.
   *
   * This exists because the failure it prevents is guaranteed otherwise: mail
   * goes to a local catcher that never delivers onward, so a user checks their
   * real inbox, sees nothing, and concludes the feature is broken. Leave it
   * unset in production — the link would be meaningless and the hint misleading.
   */
  DEV_MAIL_INBOX_URL: optionalUrl,

  // Auth rate limiting, per IP. Kept ON in every environment — brute-forcing a
  // password endpoint is the cheapest attack there is. The knobs exist because
  // the smoke gate is itself a single-IP load generator; raise them there, not
  // in production.
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // Google OAuth is optional: absent means the button is hidden and
  // email+password remains the only sign-in method.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  APP_SCHEME: z.string().default("apptemplate"),

  // ── Display formatting (apps/web/src/lib/format.ts) ────────────────────
  // How money, dates and numbers are shown to users. Server-side defaults for
  // the whole app; the /app layout hands them to client components.
  /** BCP 47 locale, e.g. en-US, en-GB, de-DE. */
  APP_LOCALE: z.preprocess(
    blankIsUnset,
    z
      .string()
      .default("en-US")
      .refine((v) => {
        try {
          return Intl.getCanonicalLocales(v).length === 1;
        } catch {
          return false;
        }
      }, "must be a BCP 47 locale tag such as en-US"),
  ),
  /** ISO 4217 currency code, e.g. USD, EUR, GBP, JPY. */
  APP_CURRENCY: z.preprocess(
    blankIsUnset,
    z
      .string()
      .regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 code such as USD")
      .default("USD"),
  ),
  /** IANA timezone used for "today" and for rendering instants, e.g. America/New_York. */
  APP_TIMEZONE: z.preprocess(
    blankIsUnset,
    z
      .string()
      .default("UTC")
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "must be an IANA timezone such as Europe/London"),
  ),

  /**
   * What is running: shown by /api/health and `deploy.sh status`. Deploys set
   * it to the git commit; unset = the root package.json version.
   */
  APP_VERSION: z.preprocess(blankIsUnset, z.string().optional()),

  // ── LLM (packages/ai) ───────────────────────────────────────────────────
  // A model is a `provider/model` string: anthropic/…, openai/…, azure/<deployment>,
  // openrouter/…, deepseek/…, local/… (LLM_BASE_URL), cli/… (Claude Code).
  // A bare name (`gpt-4.1-mini`) means local/ — the pre-router behaviour.

  /** Master switch. The smoke gate sets it false so it never spends money. */
  LLM_ENABLED: bool(true),
  /** Default model. Unset = anthropic/claude-opus-5-5 with ANTHROPIC_API_KEY, else local/gpt-4.1-mini. */
  LLM_MODEL: z.preprocess(blankIsUnset, z.string().optional()),
  /** Named tiers: app code says `tier: "fast"`, never a model id. Unset = LLM_MODEL. */
  LLM_MODEL_FAST: z.preprocess(blankIsUnset, z.string().optional()),
  LLM_MODEL_SMART: z.preprocess(blankIsUnset, z.string().optional()),
  /** Model for embed(). Unset = embeddings disabled. e.g. openai/text-embedding-3-small */
  LLM_EMBEDDING_MODEL: z.preprocess(blankIsUnset, z.string().optional()),
  /** Default reasoning effort (Anthropic output_config.effort; `--effort` for cli/). */
  LLM_EFFORT: z.preprocess(
    blankIsUnset,
    z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  ),
  /**
   * Per-tenant daily spend cap in USD (UTC day). Discretionary calls that would
   * cross it are refused BEFORE sending; essential calls always run (logged).
   */
  LLM_DAILY_CAP_USD: z.coerce.number().nonnegative().default(2),
  /**
   * Price overrides, USD per 1M tokens: `model=in:out[:cacheRead[:cacheWrite]]`,
   * comma-separated, e.g. `openai/gpt-4.1-mini=0.4:1.6,azure/gpt-5=1.25:10`.
   * Anthropic models are priced built-in; anything unpriced is recorded with
   * costKnown=false rather than guessed.
   */
  LLM_PRICES: z.string().optional(),

  // local/ (and bare names): any OpenAI-compatible server — Ollama, vLLM, LM Studio…
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  /** local/ prices (USD per 1M tokens). Kept from before the router. */
  LLM_INPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),
  LLM_OUTPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),

  ANTHROPIC_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  ANTHROPIC_BASE_URL: optionalUrl,
  OPENAI_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  OPENAI_BASE_URL: optionalUrl,
  /** Azure OpenAI / Foundry: https://<resource>.openai.azure.com (no path). */
  AZURE_OPENAI_ENDPOINT: optionalUrl,
  AZURE_OPENAI_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  /** Unset = the v1 API. A dated version (2025-04-01-preview) = deployment URLs. */
  AZURE_OPENAI_API_VERSION: z.preprocess(blankIsUnset, z.string().optional()),
  OPENROUTER_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),
  DEEPSEEK_API_KEY: z.preprocess(blankIsUnset, z.string().optional()),

  // cli/: a headless `claude -p` on the operator's Claude Code login.
  CLAUDE_BIN: z.preprocess(blankIsUnset, z.string().default("claude")),
  CLAUDE_CLI_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(300),
  /** Set both to reach `claude` through scripts/claude-bridge (apps in Docker). */
  CLAUDE_BRIDGE_URL: optionalUrl,
  CLAUDE_BRIDGE_KEY: z.preprocess(
    blankIsUnset,
    z
      .string()
      .min(32, "must be at least 32 chars (openssl rand -hex 32)")
      .optional(),
  ),

  // ── Outbound messages (packages/outbound) ──────────────────────────────
  // Every email/SMS/push passes ONE guard. See CLAUDE.md "Outbound messages".

  /**
   * Safe mode: only allowlisted recipients get real messages; everyone else is
   * logged as blocked. true = strict, false = off, local = allow everyone
   * because SMTP is a local catcher (Mailpit; refused in production). Unset =
   * off in production, strict everywhere else. Resolved by `resolveSafeMode`
   * in packages/outbound.
   */
  OUTBOUND_SAFE_MODE: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v, ctx): boolean | "local" | undefined => {
      if (v === undefined) return undefined;
      if (typeof v === "string" && v.trim().toLowerCase() === "local")
        return "local";
      const b = parseBool(v);
      if (b === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `must be "local", "true"/"1" or "false"/"0" (got ${JSON.stringify(v)})`,
        });
        return z.NEVER;
      }
      return b ?? undefined;
    }),
  /** Comma-separated: exact addresses/numbers, or `@domain` for a whole domain. */
  OUTBOUND_SAFE_RECIPIENTS: z.string().optional(),
  /** Channel switch. On by default: sign-up needs it. */
  OUTBOUND_EMAIL_ENABLED: bool(true),
  /** Global kill switch. A runtime switch also exists (`npm run outbound:freeze`). */
  OUTBOUND_FROZEN: bool(false),
  /** Volume caps (fixed windows in Redis). Over the cap = blocked, not queued. */
  OUTBOUND_CAP_RECIPIENT_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  OUTBOUND_CAP_ORG_PER_HOUR: z.coerce.number().int().positive().default(200),
  OUTBOUND_CAP_ORG_PER_DAY: z.coerce.number().int().positive().default(2000),
  OUTBOUND_CAP_GLOBAL_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .default(2000),

  // ── Security helpers (packages/security) ───────────────────────────────
  /** Bearer secret for HTTP cron endpoints. Unset in production = every call refused. */
  CRON_SECRET: z.string().optional(),
  /** HMAC secret for the email-provider events webhook (bounces, complaints). */
  EMAIL_WEBHOOK_SECRET: z.string().optional(),
  /**
   * AES-256-GCM key for sealing third-party tokens at rest: base64 of 32 bytes
   * (`openssl rand -base64 32`). Rotate by moving the old key into
   * SECRETS_ENCRYPTION_OLD_KEYS (comma-separated); old ciphertexts still open.
   */
  SECRETS_ENCRYPTION_KEY: z.preprocess(blankIsUnset, base64Key.optional()),
  SECRETS_ENCRYPTION_OLD_KEYS: z.string().optional(),

  // Storage
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: optionalUrl,
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Every variable the schema reads. Tests clear exactly these, and a test checks
 * each is in turbo.json's globalEnv (turbo's strict env mode drops the rest).
 */
export const serverEnvKeys = Object.keys(
  serverSchema.shape,
) as (keyof ServerEnv)[];

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment.\n${lines.join("\n")}\n\n` +
        `Fix your .env (start from .env.example, or run \`npm run setup\`).`,
    );
  }

  // S3 driver needs its credentials; catching it here beats a 500 on upload.
  if (parsed.data.STORAGE_DRIVER === "s3") {
    const missing = (
      ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const
    ).filter((k) => !parsed.data[k]);
    if (missing.length) {
      throw new Error(
        `STORAGE_DRIVER=s3 but these are unset: ${missing.join(", ")}`,
      );
    }
  }

  cached = parsed.data;
  return cached;
}

/** True when the "Continue with Google" button should be rendered. */
export function googleEnabled(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

/** Test-only: drop the memoised value so a test can re-validate. */
export function resetEnvCache(): void {
  cached = undefined;
}
