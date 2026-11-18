/**
 * The RAW Expo push transport: a small fetch client for the Expo push service
 * (https://docs.expo.dev/push-notifications/sending-notifications/), which
 * hands each message to APNs (iOS) or FCM (Android). No SDK: two endpoints,
 * JSON in and out.
 *
 * Internal to @repo/push-mobile and NOT exported (package.json `exports`
 * lists only the guarded entry point): the only sender is `sendMobilePush`
 * in ./index.ts, which goes through the outbound guard. ESLint refuses the
 * Expo push host and EXPO_ACCESS_TOKEN anywhere else.
 *
 * Batching: the guard sends one message per call, but Expo takes up to 100
 * per request. `transmit` queues each message and a short timer (or a full
 * batch) flushes the queue as one request; every caller gets its own ticket
 * back. A user with three devices is one HTTP request, not three.
 *
 * Two-step delivery, as Expo designs it:
 *   1. send → a TICKET per message: ok (with an id) or an error. A ticket
 *      error of DeviceNotRegistered means the app is gone from that phone.
 *   2. ~15 minutes later, getReceipts(ticket ids) → a RECEIPT per message:
 *      whether APNs/FCM accepted it. DeviceNotRegistered can show up here
 *      too, and is the common case. The worker's push.receipts job asks.
 */
import { env } from "@repo/env";
import type { ProviderReceipt, SendMeta } from "@repo/outbound";

const EXPO_PUSH = "https://exp.host/--/api/v2/push";
/** Expo's documented limits per request. */
export const MAX_SEND_BATCH = 100;
export const MAX_RECEIPT_BATCH = 1000;
/** How long the first queued message waits for others to share its request. */
const FLUSH_DELAY_MS = 25;

/** One message as the Expo push API takes it (the subset this app uses). */
export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  /** Delivered to the app, not shown. Keep it ids only. */
  data?: Record<string, string>;
  sound?: "default" | null;
  priority?: "default" | "normal" | "high";
  /** Android notification channel (created by the app; "default" exists). */
  channelId?: string;
}

export type ExpoTicket =
  | { status: "ok"; id: string }
  | {
      status: "error";
      message: string;
      details?: { error?: string; [k: string]: unknown };
    };

export type ExpoReceipt =
  | { status: "ok" }
  | {
      status: "error";
      message: string;
      details?: { error?: string; [k: string]: unknown };
    };

/** The app is uninstalled (or the token is otherwise dead): stop sending to it. */
export class DeviceNotRegisteredError extends Error {
  override name = "DeviceNotRegisteredError";
  constructor(readonly token: string) {
    super(
      "Expo push: DeviceNotRegistered (the app is no longer on that device)",
    );
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fakeFetch: FetchLike | undefined;

/**
 * Tests only: send Expo's HTTP calls to this function. Under NODE_ENV=test the
 * real network is refused (no network in `make test`).
 */
export function useFakeExpoFetch(f: FetchLike | undefined): void {
  fakeFetch = f;
  queue = [];
  if (timer) clearTimeout(timer);
  timer = undefined;
}

function http(): FetchLike {
  if (fakeFetch) return fakeFetch;
  if (env().NODE_ENV === "test") {
    throw new Error(
      "Refusing to call the Expo push service under NODE_ENV=test: use useFakeExpoFetch().",
    );
  }
  return (url, init) => fetch(url, init);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = env().EXPO_ACCESS_TOKEN;
  const res = await http()(`${EXPO_PUSH}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as {
    data?: unknown;
    errors?: { code?: string; message?: string }[];
  } | null;
  if (!res.ok || !json || json.data === undefined) {
    const err = json?.errors?.[0];
    throw new Error(
      `Expo push ${res.status}${err?.code ? ` ${err.code}` : ""}: ${err?.message ?? res.statusText}`,
    );
  }
  return json.data as T;
}

/** One request: up to MAX_SEND_BATCH messages → one ticket each, in order. */
export async function sendBatch(
  messages: ExpoMessage[],
): Promise<ExpoTicket[]> {
  if (messages.length > MAX_SEND_BATCH)
    throw new Error(`At most ${MAX_SEND_BATCH} messages per Expo request.`);
  const tickets = await post<ExpoTicket[]>("/send", messages);
  if (!Array.isArray(tickets) || tickets.length !== messages.length) {
    throw new Error(
      `Expo push returned ${Array.isArray(tickets) ? tickets.length : "no"} tickets for ${messages.length} messages.`,
    );
  }
  return tickets;
}

interface Pending {
  message: ExpoMessage;
  resolve: (t: ExpoTicket) => void;
  reject: (e: unknown) => void;
}

let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const batch = queue.splice(0, MAX_SEND_BATCH);
  if (queue.length) timer = setTimeout(flush, 0);
  if (!batch.length) return;
  sendBatch(batch.map((p) => p.message)).then(
    (tickets) => batch.forEach((p, i) => p.resolve(tickets[i]!)),
    (err) => batch.forEach((p) => p.reject(err)),
  );
}

/** Queue one message; resolves with its own ticket once its batch is sent. */
export function enqueueMessage(message: ExpoMessage): Promise<ExpoTicket> {
  return new Promise((resolve, reject) => {
    queue.push({ message, resolve, reject });
    if (queue.length >= MAX_SEND_BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_DELAY_MS);
  });
}

/**
 * Hand one message to Expo (through the batcher). The guard passes the token
 * it checked; send to that. A ticket error throws: DeviceNotRegistered as
 * DeviceNotRegisteredError (the caller disables the device), the rest as
 * plain errors the guard records as failed.
 */
export async function transmit(
  token: string,
  message: Omit<ExpoMessage, "to">,
  meta: SendMeta,
): Promise<ProviderReceipt> {
  const ticket = await enqueueMessage({
    ...message,
    to: token,
    // The outbound_message row, so the app can say which message was tapped.
    data: { ...message.data, messageId: meta.messageId },
  });
  if (ticket.status === "ok") return { providerMessageId: ticket.id };
  if (ticket.details?.error === "DeviceNotRegistered")
    throw new DeviceNotRegisteredError(token);
  throw new Error(
    `Expo push ticket error${ticket.details?.error ? ` ${ticket.details.error}` : ""}: ${ticket.message}`,
  );
}

/**
 * Receipts for ticket ids, chunked at MAX_RECEIPT_BATCH per request. An id
 * missing from the answer has no receipt YET (or is older than Expo keeps,
 * about a day): ask again later.
 */
export async function fetchReceipts(
  ids: string[],
): Promise<Record<string, ExpoReceipt>> {
  const out: Record<string, ExpoReceipt> = {};
  for (let i = 0; i < ids.length; i += MAX_RECEIPT_BATCH) {
    const chunk = ids.slice(i, i + MAX_RECEIPT_BATCH);
    Object.assign(
      out,
      await post<Record<string, ExpoReceipt>>("/getReceipts", { ids: chunk }),
    );
  }
  return out;
}
