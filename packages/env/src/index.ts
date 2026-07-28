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

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  APP_URL: z.string().url().default("http://localhost:3200"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

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
