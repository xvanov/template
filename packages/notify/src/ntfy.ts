/**
 * The RAW ntfy transport (https://ntfy.sh, or your own server). Internal to
 * @repo/notify and deliberately NOT exported: the only caller is
 * `notifyOperator` in ./index.ts, which goes through the outbound guard with
 * this as the callback. Only this file may read NTFY_URL / NTFY_TOKEN (an
 * ESLint rule in eslint.boundaries.mjs), so nothing else can build the request.
 *
 * The topic is the secret: on a public server whoever knows it reads every
 * message. It is never printed (the guard's logs mask it).
 */
import { env } from "@repo/env";
import { isLoopbackHost, type ProviderReceipt } from "@repo/outbound";

import { ntfyPriority, type Priority } from "./policy";

const TIMEOUT_MS = 10_000;

export interface PushMessage {
  title: string;
  body: string;
  priority: Priority;
  /** Overrides the priority's mapping (the digest is sent at 3). */
  ntfyPriority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  url?: string | null;
}

/** Is a push channel configured at all? (Topic set; the guard decides the rest.) */
export function operatorTopic(): string | undefined {
  return env().NTFY_TOPIC;
}

/**
 * Pure: the JSON publish request. POST to the server ROOT with the topic in
 * the body; unlike ntfy's header form, it carries any UTF-8 title.
 */
export function ntfyRequest(
  msg: PushMessage,
  opts: { server: string; topic: string; token?: string },
): { url: string; init: RequestInit } {
  const payload: Record<string, unknown> = {
    topic: opts.topic,
    title: msg.title.slice(0, 250),
    // ntfy turns messages over 4096 bytes into attachments; stay well under.
    message: (msg.body.trim() || msg.title).slice(0, 3500),
    priority: msg.ntfyPriority ?? ntfyPriority(msg.priority),
  };
  if (msg.tags?.length) payload.tags = msg.tags.slice(0, 10);
  // A tap opens the link, but a loopback one means nothing on a phone.
  if (msg.url && /^https?:\/\//.test(msg.url)) {
    const host = new URL(msg.url).hostname;
    if (!isLoopbackHost(host)) payload.click = msg.url;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return {
    url: `${opts.server.replace(/\/+$/, "")}/`,
    init: { method: "POST", headers, body: JSON.stringify(payload) },
  };
}

/** Publish one message to `topic` (the guard's parsed recipient). Throws on failure. */
export async function transmitPush(
  topic: string,
  msg: PushMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderReceipt> {
  const e = env();
  // Under a test runner a push may only go to this machine: a unit test that
  // reaches ntfy.sh buzzes a real phone. Same rule as the SMTP transport.
  if (e.NODE_ENV === "test" && !isLoopbackHost(new URL(e.NTFY_URL).hostname)) {
    throw new Error(
      `Refusing to push to "${e.NTFY_URL}" under NODE_ENV=test: only a loopback server is allowed.`,
    );
  }
  const req = ntfyRequest(msg, {
    server: e.NTFY_URL,
    topic,
    token: e.NTFY_TOKEN,
  });
  const res = await fetchImpl(req.url, {
    ...req.init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ntfy ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as { id?: unknown };
  return {
    providerMessageId: typeof json.id === "string" ? json.id : undefined,
  };
}
