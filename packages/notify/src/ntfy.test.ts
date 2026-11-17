/**
 * The ntfy request shape and transport, offline: a fake fetch records what
 * would have been sent. The live shape was checked once against ntfy.sh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@repo/env";

import { ntfyRequest, transmitPush } from "./ntfy";

const msg = {
  title: "Job failed — ünïcode ok",
  body: "line 1\nline 2",
  priority: "high" as const,
};

describe("ntfyRequest", () => {
  it("POSTs JSON to the server root with the topic in the body", () => {
    const r = ntfyRequest(
      { ...msg, tags: ["warning"], url: "https://app.example.com/x" },
      { server: "https://ntfy.example.com//", topic: "t0p1c" },
    );
    expect(r.url).toBe("https://ntfy.example.com/");
    expect(r.init.method).toBe("POST");
    expect(JSON.parse(String(r.init.body))).toEqual({
      topic: "t0p1c",
      title: msg.title,
      message: msg.body,
      priority: 4,
      tags: ["warning"],
      click: "https://app.example.com/x",
    });
    expect(r.init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("sends the token as a Bearer header; drops loopback click links; never an empty message", () => {
    const r = ntfyRequest(
      { ...msg, body: " ", url: "http://localhost:3200/app" },
      { server: "https://n.test", topic: "t", token: "tk_1" },
    );
    const body = JSON.parse(String(r.init.body));
    expect(body.click).toBeUndefined();
    expect(body.message).toBe(msg.title);
    expect((r.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tk_1",
    );
  });
});

describe("transmitPush", () => {
  beforeEach(() => {
    process.env.NTFY_URL = "http://127.0.0.1:9";
    resetEnvCache();
  });
  afterEach(() => {
    delete process.env.NTFY_URL;
    resetEnvCache();
  });

  it("returns ntfy's message id", async () => {
    const fake = vi.fn(async () => Response.json({ id: "abc123" }));
    const receipt = await transmitPush("t", msg, fake as typeof fetch);
    expect(receipt.providerMessageId).toBe("abc123");
    expect(fake).toHaveBeenCalledWith(
      "http://127.0.0.1:9/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on an HTTP error, so the guard records it as failed", async () => {
    const fake = async () => new Response("topic is reserved", { status: 403 });
    await expect(transmitPush("t", msg, fake as typeof fetch)).rejects.toThrow(
      /ntfy 403: topic is reserved/,
    );
  });

  it("refuses a non-loopback server under NODE_ENV=test, before any request", async () => {
    process.env.NTFY_URL = "https://ntfy.sh";
    resetEnvCache();
    const fake = vi.fn();
    await expect(transmitPush("t", msg, fake as typeof fetch)).rejects.toThrow(
      /Refusing to push/,
    );
    expect(fake).not.toHaveBeenCalled();
  });
});
