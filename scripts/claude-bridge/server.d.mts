// Types for the pure helpers server.mjs exports (used by packages/ai tests).
export function hostAllowed(host: string): boolean;
export function keyOk(header: unknown, key?: string): boolean;
export function claudeArgs(opts: {
  model: string;
  system?: string;
  effort?: string;
  jsonSchema?: Record<string, unknown>;
}): string[];
