// Run a command with the monorepo-root .env loaded.
//
//   node scripts/with-root-env.mjs next dev
//
// `next dev` only reads .env files from apps/web, but this repo keeps a single
// .env at the root — so without this every server render fails with "Invalid
// environment". Variables already set in the environment win (CI, Docker, the
// smoke gate), and a missing file is not an error: `@repo/env` reports anything
// actually absent. It runs before Next starts, so next.config.ts sees the
// values too (allowedDevOrigins is derived from them). `next dev` / `next
// start` without a port get WEB_PORT from that .env (default 3200), the same
// port docker compose publishes the web app on.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-root-env.mjs <command> [args...]");
  process.exit(2);
}
if (
  command === "next" &&
  ["dev", "start"].includes(args[0]) &&
  !args.some((a) => a === "-p" || a.startsWith("--port"))
) {
  args.push("--port", process.env.WEB_PORT || "3200");
}

// No shell on POSIX: an intermediate `sh` does not reliably forward SIGTERM,
// which orphans the dev server. Windows needs one to resolve `next.cmd`, and
// there we pass ONE pre-quoted string: shell + an args array is deprecated
// (DEP0190) because Node does not escape the args.
const quoteWin = (arg) =>
  /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
const child =
  process.platform === "win32"
    ? spawn([command, ...args].map(quoteWin).join(" "), {
        stdio: "inherit",
        shell: true,
      })
    : spawn(command, args, { stdio: "inherit" });
child.on("error", (err) => {
  console.error(`with-root-env: could not start ${command}: ${err.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (!signal) process.exit(code ?? 0);
  // Re-raise the child's signal on ourselves, without our forwarder in the way.
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
