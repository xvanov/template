/**
 * Shared unit-test environment.
 *
 * `@repo/env` fails fast on missing variables — which is exactly what we want
 * in production, and exactly what would make every unit test depend on a real
 * .env. So provide a minimal, obviously-fake baseline here instead.
 *
 * The values must be syntactically valid but must NOT point at anything real:
 * a unit test that accidentally reaches a live database should fail to connect,
 * not quietly mutate it. Port 1 is unbindable.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.REDIS_URL ??= "redis://127.0.0.1:1";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-production-use-32+";
process.env.APP_URL ??= "http://localhost:3200";
