/**
 * Reads mail out of Mailpit, the local SMTP server from docker-compose.
 *
 * This is what lets the confirmation flow be *tested* rather than trusted: the
 * message goes over real SMTP, and the test opens the link a user would open.
 * No third-party account, nothing leaves the machine.
 */
const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://localhost:8035";

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Delete every message. Call before a test that asserts on "the" email. */
export async function clearInbox(): Promise<void> {
  await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: "DELETE" });
}

/**
 * Poll for the confirmation email sent to `address` and return its link.
 *
 * The link's origin is rewritten to `baseUrl`: the server builds it from its own
 * APP_URL, which is not necessarily the origin the test is driving (the smoke
 * gate uses an isolated port). Rewriting keeps the test honest about the flow
 * without coupling it to one deployment's configuration.
 */
export async function waitForVerificationLink(
  address: string,
  baseUrl: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 0;

  while (Date.now() < deadline) {
    const res = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    );
    if (res.ok) {
      const body = (await res.json()) as { messages?: MailpitSummary[] };
      const messages = body.messages ?? [];
      lastSeen = messages.length;

      for (const summary of messages) {
        const detail = await fetch(
          `${MAILPIT_URL}/api/v1/message/${summary.ID}`,
        );
        if (!detail.ok) continue;
        const { Text } = (await detail.json()) as { Text?: string };
        const match = /https?:\/\/\S*verify-email\S*/.exec(Text ?? "");
        if (match) {
          const link = new URL(match[0].replace(/[.,)\]]+$/, ""));
          const target = new URL(baseUrl);
          link.protocol = target.protocol;
          link.host = target.host;
          return link.toString();
        }
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  throw new Error(
    `No confirmation email for ${address} within ${timeoutMs}ms ` +
      `(${lastSeen} message(s) matched; is Mailpit up? \`docker compose up -d mailpit\`)`,
  );
}
