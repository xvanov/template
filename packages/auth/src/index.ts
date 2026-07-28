/**
 * The auth server. One instance, mounted by the web app at
 * `/api/auth/[...all]`, used by BOTH the web and the mobile client.
 *
 * Sign-in methods:
 *   - email + password  — always available, no external setup
 *   - Google OAuth      — enabled only when both GOOGLE_* vars are set
 *
 * Multi-tenancy: every user gets a personal organization on sign-up, and every
 * session is stamped with an `activeOrganizationId`. `packages/api` reads that
 * stamp and scopes every query to it, so tenant isolation is enforced in one
 * place rather than per-resolver.
 *
 * Built LAZILY (see the proxy at the bottom): `next build` walks the module
 * graph, and an eagerly-built instance would make compiling the app require a
 * real BETTER_AUTH_SECRET and DATABASE_URL. An image should build once and run
 * in any environment.
 */
import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { db } from "@repo/db";
import { sendMail, verificationEmail } from "@repo/email";
import { env, googleEnabled } from "@repo/env";

/**
 * Inferred from `build`, not annotated as `ReturnType<typeof betterAuth>`:
 * betterAuth's return type is parameterised by the exact options object, and the
 * generic form loses the plugin-derived endpoints (organization, expo).
 */
type AuthInstance = ReturnType<typeof build>;

function build() {
  const e = env();

  /**
   * The origins allowed to complete an auth round trip — a CSRF boundary, so it
   * is an explicit list, never a wildcard.
   *
   * If you see "Invalid origin", the app is being reached on an origin that is
   * not listed: set APP_URL to the real origin, or add it to TRUSTED_ORIGINS
   * (comma-separated) for tunnels, preview deploys and LAN addresses.
   */
  const trustedOrigins = [
    e.APP_URL,
    e.BETTER_AUTH_URL ?? e.APP_URL,
    // Expo deep link back into the native app after the OAuth browser hop.
    `${e.APP_SCHEME}://`,
    // Expo dev server, for a phone on the same wifi.
    "http://localhost:8091",
    "exp://",
    ...(e.TRUSTED_ORIGINS?.split(",").map((s) => s.trim()) ?? []),
  ].filter((origin): origin is string => Boolean(origin));

  return betterAuth({
    appName: "app-template",
    secret: e.BETTER_AUTH_SECRET,
    baseURL: e.BETTER_AUTH_URL ?? e.APP_URL,
    trustedOrigins,

    database: prismaAdapter(db, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      // ON by default (REQUIRE_EMAIL_VERIFICATION): without it anyone can sign
      // up as anyone else's address. The mail goes over local SMTP — see
      // @repo/email — so this works with no third-party account.
      requireEmailVerification: e.REQUIRE_EMAIL_VERIFICATION,
      minPasswordLength: 8,
    },

    emailVerification: {
      sendOnSignUp: true,
      // Clicking the link both verifies and signs you in, so the user lands in
      // the app instead of on a form asking for the password they just chose.
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        try {
          await sendMail({ to: user.email, ...verificationEmail(url) });
        } catch (err) {
          // Never let a mail failure break sign-up: the account exists and the
          // user can ask for another link. Log loudly so it is not invisible.
          console.error(
            `[auth] could not send verification email to ${user.email}:`,
            err,
          );
        }
      },
    },

    socialProviders: googleEnabled()
      ? {
          google: {
            clientId: e.GOOGLE_CLIENT_ID!,
            clientSecret: e.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {},

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    },

    // Explicit rather than implicit: the defaults are reasonable, but a limit you
    // cannot see is a limit you will be surprised by. Tune via env, never by
    // switching this off.
    rateLimit: {
      enabled: true,
      window: e.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      max: e.AUTH_RATE_LIMIT_MAX,
      // better-auth applies its own STRICTER defaults to the credential paths,
      // so the global `max` above does not govern them. State them explicitly,
      // or tuning the ceiling silently has no effect where it matters.
      customRules: {
        "/sign-up/email": {
          window: e.AUTH_RATE_LIMIT_WINDOW_SECONDS,
          max: e.AUTH_RATE_LIMIT_MAX,
        },
        "/sign-in/email": {
          window: e.AUTH_RATE_LIMIT_WINDOW_SECONDS,
          max: e.AUTH_RATE_LIMIT_MAX,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Give every new user a tenant of their own, immediately. Without
          // this, a signed-in user with no membership sees an empty app and
          // every org-scoped query has to handle a null tenant.
          after: async (user) => {
            const org = await db.organization.create({
              data: {
                name: user.name ? `${user.name}'s workspace` : "My workspace",
                slug: `${slugify(user.name || user.email.split("@")[0] || "workspace")}-${user.id.slice(-6)}`,
              },
            });
            await db.member.create({
              data: { organizationId: org.id, userId: user.id, role: "owner" },
            });
          },
        },
      },
      session: {
        create: {
          // Stamp the session with a tenant at creation time.
          //
          // This fires for SIGN-IN. On SIGN-UP the session is created before the
          // hook above has made the membership, so a new account's first session
          // is unstamped; `orgProcedure` in packages/api repairs it on first use.
          before: async (session) => {
            const membership = await db.member.findFirst({
              where: { userId: session.userId },
              orderBy: { createdAt: "asc" },
              select: { organizationId: true },
            });
            return {
              data: {
                ...session,
                activeOrganizationId: membership?.organizationId ?? null,
              },
            };
          },
        },
      },
    },

    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 10,
      }),
      // MUST stay last: the Expo plugin wraps responses so the native client can
      // pull the session cookie out of the deep-link callback.
      expo(),
    ],
  });
}

let instance: AuthInstance | undefined;

export const auth: AuthInstance = new Proxy({} as AuthInstance, {
  get(_t, prop) {
    instance ??= build();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
  has(_t, prop) {
    instance ??= build();
    return prop in instance;
  },
});

export type Auth = AuthInstance;
export type Session = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "workspace"
  );
}
