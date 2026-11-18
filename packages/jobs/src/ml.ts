/**
 * The bridge to the Python sidecar in ml/: run a script as a CHILD PROCESS,
 * JSON on stdin, JSON on stdout, with a timeout.
 *
 * Why a process per job and not a Python web service: a job is already the
 * slow, retried, recorded unit of work here (job_run), so the only thing the
 * bridge must add is "run this and give me the answer". A child process has no
 * port to secure, no second service to deploy, health-check or restart, and no
 * Python at all unless ML_ENABLED is on. What it costs is start-up time (uv +
 * Python + numpy: about half a second), paid per job. That is the wrong shape
 * for a big model that takes 30 seconds to load and should stay in GPU memory:
 * serve that with vLLM (ml/serve/, OpenAI-compatible) and call it through
 * packages/ai as `local/<model>`, like any other LLM.
 *
 * Contract: ml/src/mlkit/predict.py; example of both sides:
 * ml/contract/predict.example.json, checked by tests in both languages.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "@repo/env";
import { z } from "zod";

/** stdout larger than this is a bug (or an attack on the worker's memory). */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
/** Kept for the error message when the process fails. */
const STDERR_TAIL_BYTES = 4000;

export class MlProcessError extends Error {
  constructor(
    message: string,
    readonly stderrTail = "",
  ) {
    super(
      stderrTail ? `${message}\n--- stderr (tail) ---\n${stderrTail}` : message,
    );
    this.name = "MlProcessError";
  }
}

export interface RunJsonOptions {
  timeoutMs: number;
  cwd?: string;
  /** Extra environment for the child (merged over a minimal allowlist). */
  env?: Record<string, string>;
  /** After SIGTERM, how long before SIGKILL. */
  killGraceMs?: number;
}

/**
 * The child's environment: PATH and HOME (uv needs them to find Python and its
 * cache) and nothing else of the worker's. The app's secrets (database URL,
 * auth secret, API keys) are none of the model's business.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "TMPDIR",
    "UV_CACHE_DIR",
    "UV_PYTHON_INSTALL_DIR",
  ];
  const base: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return { ...base, PYTHONUNBUFFERED: "1", ...extra };
}

/**
 * Run `command args...`, write `input` as JSON to its stdin, parse its stdout
 * as ONE JSON document. Rejects with MlProcessError on a non-zero exit, a
 * timeout, oversize or non-JSON output; the stderr tail is in the message.
 */
export function runJsonProcess(
  command: string,
  args: string[],
  input: unknown,
  opts: RunJsonOptions,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      // A cast, not a widening: some workspaces' ProcessEnv (Expo's) requires NODE_ENV.
      env: childEnv(opts.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise(value);
    };
    const kill = (why: string) => {
      child.kill("SIGTERM");
      killTimer = setTimeout(
        () => child.kill("SIGKILL"),
        opts.killGraceMs ?? 2000,
      );
      killTimer.unref();
      finish(new MlProcessError(why, errTail));
    };

    const timer = setTimeout(
      () => kill(`${command} timed out after ${opts.timeoutMs} ms`),
      opts.timeoutMs,
    );

    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        kill(`${command} wrote more than ${MAX_STDOUT_BYTES} bytes to stdout`);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errTail = (errTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (err) =>
      finish(new MlProcessError(`could not start ${command}: ${err.message}`)),
    );
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) {
        finish(
          new MlProcessError(
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
            errTail,
          ),
        );
        return;
      }
      const text = Buffer.concat(out).toString("utf8").trim();
      try {
        finish(null, JSON.parse(text));
      } catch {
        finish(
          new MlProcessError(
            `${command} did not print one JSON document on stdout (got ${JSON.stringify(text.slice(0, 200))})`,
            errTail,
          ),
        );
      }
    });
    // A child that exits without reading its stdin makes this write EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// ── the predict contract (ml/src/mlkit/predict.py) ────────────────────────
export const predictResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    model: z.object({ run_id: z.string(), kind: z.string() }),
    predictions: z.array(
      z.object({ id: z.string(), score: z.number(), urgent: z.boolean() }),
    ),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type PredictResponse = z.infer<typeof predictResponse>;

export interface PredictItem {
  id: string;
  title: string;
  notes: string | null;
}

/** <repo>/ml, from this file (packages/jobs/src/ml.ts). Used only when ML_PROJECT_DIR is unset. */
export function defaultProjectDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../ml");
}

/** Score items with the latest model trained in ml/ (`uv run train`). */
export async function predictItems(
  items: PredictItem[],
): Promise<PredictResponse> {
  const e = env();
  const project = e.ML_PROJECT_DIR ?? defaultProjectDir();
  const raw = await runJsonProcess(
    e.ML_UV_BIN,
    // --frozen: exactly what uv.lock says, never re-resolved on a worker.
    // --no-dev: pytest/ruff are not needed to predict (and an image built
    // with `uv sync --no-dev` would otherwise try to install them).
    ["run", "--project", project, "--frozen", "--no-dev", "--quiet", "predict"],
    { items },
    { timeoutMs: e.ML_TIMEOUT_SECONDS * 1000, cwd: project },
  );
  const parsed = predictResponse.safeParse(raw);
  if (!parsed.success) {
    throw new MlProcessError(
      `predict answered in an unexpected shape: ${parsed.error.message.slice(0, 500)}`,
    );
  }
  return parsed.data;
}
