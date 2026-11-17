// Types for the pure helpers server.mjs exports (used by packages/ai tests).
import type { NetworkInterfaceInfo } from "node:os";

export const NEUTRAL_SYSTEM_PROMPT: string;
export function hostAllowed(
  host: string,
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>,
  trustHost?: string,
): boolean;
export function validate(body: unknown): string | null;
export function keyOk(header: unknown, key?: string): boolean;
export function childEnv(
  source: Record<string, string | undefined>,
): Record<string, string>;
export function claudeArgs(opts: {
  model: string;
  system?: string;
  effort?: string;
  jsonSchema?: Record<string, unknown>;
}): string[];
