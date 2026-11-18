/**
 * The Python bridge, tested WITHOUT Python: the child is `node -e <script>`,
 * so `make test` never needs uv. The real Python side is tested by ml/'s own
 * pytest (CI: .github/workflows/ml.yml), against the same contract file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkPredictionIds,
  CHILD_ENV_ALLOWLIST,
  MlProcessError,
  predictResponse,
  runJsonProcess,
} from "./ml";

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

  it.skipIf(process.platform === "win32")(
    "a timeout kills the whole process group: a child that traps SIGTERM, and its grandchild",
    async () => {
      // What `uv run` -> python -> a worker process looks like when python
      // ignores SIGTERM.
      const stubborn = `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => {});
        const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
        console.error("PIDS " + process.pid + " " + g.pid);
        setInterval(() => {}, 1000);`;
      const err = (await runJsonProcess(
        node,
        ["-e", stubborn],
        {},
        {
          timeoutMs: 800,
          killGraceMs: 300,
        },
      ).catch((e: unknown) => e)) as Error;
      expect(err.message).toMatch(/timed out after 800 ms/);
      const [, leader, grandchild] = /PIDS (\d+) (\d+)/.exec(err.message)!;
      const alive = (pid: string) => {
        try {
          process.kill(Number(pid), 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 5000;
      while ((alive(leader!) || alive(grandchild!)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(alive(leader!)).toBe(false);
      expect(alive(grandchild!)).toBe(false);
    },
  );

  it("does not leave a grandchild running after a normal answer", async () => {
    const leaky = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stdout.write(JSON.stringify({ grandchild: g.pid }));
      process.exit(0);`;
    const out = (await run(leaky)) as { grandchild: number };
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(out.grandchild, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
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

  it("passes uv's deployment settings through (the Docker recipe sets UV_NO_SYNC)", async () => {
    expect(CHILD_ENV_ALLOWLIST).toContain("UV_NO_SYNC");
    process.env.UV_NO_SYNC = "1";
    try {
      await expect(
        run(
          `process.stdout.write(JSON.stringify(process.env.UV_NO_SYNC ?? null))`,
        ),
      ).resolves.toBe("1");
    } finally {
      delete process.env.UV_NO_SYNC;
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

describe("checkPredictionIds", () => {
  const items = [{ id: "a", title: "x", notes: null }];
  const answer = (ids: string[]) => ({
    ok: true as const,
    model: { run_id: "r", kind: "k" },
    predictions: ids.map((id) => ({ id, score: 0.5, urgent: false })),
  });

  it("accepts predictions about the items that were sent", () => {
    expect(() => checkPredictionIds(items, answer(["a"]))).not.toThrow();
    expect(() => checkPredictionIds(items, answer([]))).not.toThrow();
  });

  it("refuses a prediction about an id it was not given", () => {
    expect(() =>
      checkPredictionIds(items, answer(["a", "other-tenant-row"])),
    ).toThrow(/ids it was not given/);
  });
});
