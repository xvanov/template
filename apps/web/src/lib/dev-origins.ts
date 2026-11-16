/**
 * Hostnames the Next dev server should serve its scripts to.
 *
 * `next dev` refuses its JS/HMR endpoints to any host it does not know, so a
 * page opened over Tailscale or a LAN address renders HTML that never hydrates
 * (forms fall back to plain GET). The hosts we already trust for auth —
 * APP_URL plus TRUSTED_ORIGINS — are exactly the ones a developer opens.
 *
 * Pure (takes the env as an argument) and forgiving: a malformed entry is
 * skipped rather than crashing the config. better-auth still validates the
 * same list strictly at runtime.
 */
export function devOriginHosts(
  env: Record<string, string | undefined>,
): string[] {
  const origins = [env.APP_URL, ...(env.TRUSTED_ORIGINS ?? "").split(",")];
  const hosts = new Set<string>();
  for (const origin of origins) {
    const value = origin?.trim();
    if (!value) continue;
    try {
      hosts.add(new URL(value).hostname);
    } catch {
      // Not a URL; @repo/env / better-auth will complain where it matters.
    }
  }
  return [...hosts];
}
