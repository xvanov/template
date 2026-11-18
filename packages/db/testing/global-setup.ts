/**
 * Vitest globalSetup for tests that need a REAL Postgres: one throwaway,
 * migrated schema per `vitest run`, dropped afterwards. How and why: see
 * ./schema.ts.
 */
import type { TestProject } from "vitest/node";

import { createThrowawaySchema } from "./schema";

export default async function setup(project: TestProject) {
  const t = await createThrowawaySchema();
  project.provide("databaseUrl", t.url);
  return t.drop;
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
