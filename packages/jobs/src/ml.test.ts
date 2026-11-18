/**
 * The Python bridge, tested WITHOUT Python: the child is `node -e <script>`,
 * so `make test` never needs uv. The real Python side is tested by ml/'s own
 * pytest (CI: .github/workflows/ml.yml), against the same contract file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MlProcessError, predictResponse, runJsonProcess } from "./ml";

const node = process.execPath;
const run = (script: string, input: unknown = {}, timeoutMs = 10_000) =>
  runJsonProcess(node, ["-e", script], input, { timeoutMs, killGraceMs: 200 });

describe("runJsonProcess", () => {
  it("sends JSON on stdin and parses the JSON on stdout (logs on stderr are fine)", async () => {
    const echo = `
      let s = ""; process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        console.error("loading model...");
        const req = JSON.parse(s);
        process.stdout.write(JSON.stringify({ ok: true, n: req.items.length }) + "\\n");
      });`;
    await expect(run(echo, { items: [1, 2, 3] })).resolves.toEqual({
      ok: true,
      n: 3,
    });
  });

  it("a non-zero exit rejects with the stderr tail in the message", async () => {
    const err = await run(
      `console.error("Traceback: ValueError: bad weights"); process.exit(3)`,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlProcessError);
    expect((err as Error).message).toMatch(/exited with code 3/);
    expect((err as Error).message).toMatch(/ValueError: bad weights/);
  });

  it("a hung process is killed at the timeout", async () => {
    const t0 = Date.now();
    await expect(run(`setInterval(() => {}, 1000)`, {}, 300)).rejects.toThrow(
      /timed out after 300 ms/,
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("stdout that is not one JSON document is an error, not a guess", async () => {
    await expect(
      run(`console.log("epoch 1"); console.log(JSON.stringify({ ok: true }))`),
    ).rejects.toThrow(/did not print one JSON document/);
  });

  it("a missing binary says it could not start", async () => {
    await expect(
      runJsonProcess("/nonexistent/uv", [], {}, { timeoutMs: 5000 }),
    ).rejects.toThrow(/could not start \/nonexistent\/uv/);
  });

  it("does not hand the worker's secrets to the child", async () => {
    process.env.DATABASE_URL_PROBE = "postgres://secret";
    try {
      const out = await run(
        `process.stdout.write(JSON.stringify({ leaked: process.env.DATABASE_URL_PROBE ?? null, path: !!process.env.PATH }))`,
      );
      expect(out).toEqual({ leaked: null, path: true });
    } finally {
      delete process.env.DATABASE_URL_PROBE;
    }
  });

  it("a child that ignores stdin still works", async () => {
    await expect(
      run(`process.stdout.write("[]")`, { big: "x".repeat(200_000) }),
    ).resolves.toEqual([]);
  });
});

describe("the predict contract (ml/contract/predict.example.json)", () => {
  const example = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../../../ml/contract/predict.example.json"),
      "utf8",
    ),
  ) as { request: { items: unknown[] }; response: unknown };

  it("the example response is what predictItems accepts", () => {
    // ml/tests/test_train_predict.py checks the real Python output has this shape.
    expect(predictResponse.parse(example.response)).toMatchObject({ ok: true });
  });

  it("an expected failure is a reason, not a crash", () => {
    expect(
      predictResponse.parse({ ok: false, reason: "no trained model yet" }),
    ).toEqual({ ok: false, reason: "no trained model yet" });
  });

  it("the example request has the fields the job sends", () => {
    for (const item of example.request.items) {
      expect(Object.keys(item as object).sort()).toEqual([
        "id",
        "notes",
        "title",
      ]);
    }
  });
});
