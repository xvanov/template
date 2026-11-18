/**
 * The demo seed's safety rules, kept pure so they are unit-tested
 * (guard.test.ts). The seed writes a KNOWN password, so it must never:
 *   - run against a database that is not on this machine, unless asked
 *     explicitly (--allow-remote-db, from DEMO_ALLOW_REMOTE_DB=1);
 *   - take over an account or a workspace it did not create itself. What it
 *     created is marked in the organization's `metadata` (DEMO_MARKER), with
 *     the id of the user it created.
 */
export const DEMO_MARKER = "demoSeed";

export interface DemoMark {
  demoSeed: true;
  userId: string | null;
}

/** Hosts that mean "this machine". The dev compose stack publishes on loopback. */
export function isLocalDatabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** The marker in an organization's metadata, or null (not created by the seed). */
export function readMark(metadata: string | null | undefined): DemoMark | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    if (parsed && parsed[DEMO_MARKER] === true) {
      return {
        demoSeed: true,
        userId: typeof parsed.userId === "string" ? parsed.userId : null,
      };
    }
  } catch {
    // Not JSON: someone else's metadata.
  }
  return null;
}

export function writeMark(userId: string): string {
  return JSON.stringify({ [DEMO_MARKER]: true, userId });
}

/**
 * Whether the seed may proceed, given what already exists. Returns a reason
 * to refuse, or null.
 */
export function ownershipProblem(input: {
  slug: string;
  email: string;
  org: { metadata: string | null } | null;
  user: { id: string } | null;
}): string | null {
  const mark = input.org ? readMark(input.org.metadata) : null;
  if (input.org && !mark) {
    return `an organization with slug "${input.slug}" exists and was not created by the demo seed; refusing to touch it (change DEMO_ORG.slug in apps/worker/src/demo/data.ts)`;
  }
  if (input.user && (!mark || mark.userId !== input.user.id)) {
    return `an account ${input.email} exists that the demo seed did not create; refusing to reset its password (use DEMO_EMAIL=<another address>)`;
  }
  return null;
}
