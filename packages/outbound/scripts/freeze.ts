/**
 * The runtime kill switch, for operators:
 *
 *   npm run outbound:freeze -- on            stop ALL outbound messages now
 *   npm run outbound:freeze -- on email      stop one channel (email | push)
 *   npm run outbound:freeze -- off [channel] lift it
 *   npm run outbound:freeze -- status
 *
 * Takes effect on the next send in every process; no restart, no deploy.
 */
import "@repo/env/load";

import { userInfo } from "node:os";

import { db } from "@repo/db";

import { isFrozen, setFrozen, type FreezeScope } from "../src/controls";
import { CHANNELS } from "../src/policy";

const [command, scopeArg = "all"] = process.argv.slice(2);
const scopes = ["all", ...CHANNELS];

async function main() {
  if (!scopes.includes(scopeArg))
    throw new Error(`scope must be one of ${scopes.join(", ")}`);
  const scope = scopeArg as FreezeScope;
  if (command === "on" || command === "off") {
    const state = await setFrozen(
      scope,
      command === "on",
      `cli:${userInfo().username}`,
    );
    console.log(`outbound freeze ${command} (${scope}). state:`, state);
  } else if (command === "status") {
    for (const ch of CHANNELS) {
      console.log(`${ch}: ${(await isFrozen(ch)) ? "FROZEN" : "open"}`);
    }
  } else {
    console.log(
      `usage: npm run outbound:freeze -- on|off|status [${scopes.join("|")}]`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
