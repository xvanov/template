/**
 * POST /api/media/transcribe with a real signed session: signed-in only, an
 * audio allow-list before anything is sent, and a clean "not set up" when no
 * transcription model is configured (the default). The happy path's pricing
 * and wire format are unit-tested in packages/ai (transcribe.test.ts).
 */
import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { createTenant, type TestTenant } from "@repo/db/testing";
import { env, resetEnvCache } from "@repo/env";

import { POST } from "./transcribe/route";

function cookieFor(t: TestTenant): string {
  const sig = createHmac("sha256", env().BETTER_AUTH_SECRET)
    .update(t.sessionToken)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${t.sessionToken}.${sig}`)}`;
}

function post(t: TestTenant | null, file: File) {
  const form = new FormData();
  form.set("file", file);
  return POST(
    new Request("http://localhost:3200/api/media/transcribe", {
      method: "POST",
      headers: t ? { cookie: cookieFor(t) } : {},
      body: form,
    }),
  );
}

const m4a = () =>
  new File([new Uint8Array(4000)], "note.m4a", { type: "audio/x-m4a" });

afterEach(() => {
  delete process.env.LLM_TRANSCRIBE_MODEL;
  resetEnvCache();
});

describe("/api/media/transcribe", () => {
  it("needs a session", async () => {
    expect((await post(null, m4a())).status).toBe(401);
  });

  it("refuses anything that is not audio, before any provider is asked", async () => {
    const a = await createTenant("tx-type");
    const res = await post(
      a,
      new File(["<script>"], "x.html", { type: "text/html" }),
    );
    expect(res.status).toBe(415);
  });

  it("says plainly when transcription is not set up (the default)", async () => {
    delete process.env.LLM_TRANSCRIBE_MODEL;
    resetEnvCache();
    const a = await createTenant("tx-off");
    const res = await post(a, m4a());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Transcription is not set up on this server.",
    });
  });
});
