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

/** "true"/"1" → true, anything else → false; a real boolean passes through. */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === "true" || v === "1");

/** `VAR=` in a .env file means "unset", not "the empty string". */
const blankIsUnset = (v: unknown) => (v === "" ? undefined : v);

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
  BETTER_AUTH_URL: z.string().url().optional(),

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
  REQUIRE_EMAIL_VERIFICATION: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => v === true || v === "true" || v === "1"),

  // SMTP. Unset SMTP_HOST = mail is logged to the console instead of sent, so a
  // fresh clone runs with no mail infrastructure. `docker compose up -d mailpit`
  // gives you a real local SMTP server and inbox.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1035),
  SMTP_SECURE: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1"),
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
  DEV_MAIL_INBOX_URL: z.string().optional(),

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

  // LLM — any OpenAI-compatible endpoint. Absent key = feature disabled.
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-4.1-mini"),
  LLM_INPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),
  LLM_OUTPUT_COST_PER_MTOK: z.coerce.number().nonnegative().default(0),

  // ── Outbound messages (packages/outbound) ──────────────────────────────
  // Every email/SMS/push passes ONE guard. See CLAUDE.md "Outbound messages".

  /**
   * Safe mode: only allowlisted recipients get real messages; everyone else is
   * logged as blocked. true = strict, false = off, local = allow everyone
   * because SMTP is a local catcher (Mailpit; refused in production). Unset =
   * off in production, strict everywhere else. Resolved by `resolveSafeMode`
   * in packages/outbound.
   */
  OUTBOUND_SAFE_MODE: z.preprocess(
    blankIsUnset,
    z.union([z.literal("local"), boolish]).optional(),
  ),
  /** Comma-separated: exact addresses/numbers, or `@domain` for a whole domain. */
  OUTBOUND_SAFE_RECIPIENTS: z.string().optional(),
  /** Channel switch. On by default: sign-up needs it. */
  OUTBOUND_EMAIL_ENABLED: boolish.default(true),
  /** Global kill switch. A runtime switch also exists (`npm run outbound:freeze`). */
  OUTBOUND_FROZEN: boolish.default(false),
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
  S3_ENDPOINT: z.string().optional(),
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

/** True when the LLM features should be offered at all. */
export function llmEnabled(): boolean {
  return Boolean(env().LLM_API_KEY);
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
