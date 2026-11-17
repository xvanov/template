/**
 * Test helper: reset every LLM-related variable, then apply `vars`. Starts from
 * a clean slate so a developer's real .env (or CI's) can never leak into an
 * assertion — and never make a test reach a real provider.
 */
import { resetEnvCache, serverEnvKeys } from "@repo/env";

const LLM_KEYS = serverEnvKeys.filter((k) =>
  /^(LLM_|ANTHROPIC_|OPENAI_|AZURE_|OPENROUTER_|DEEPSEEK_|CLAUDE_)/.test(k),
);

export function setLlmEnv(vars: Record<string, string> = {}): void {
  for (const k of LLM_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  resetEnvCache();
}
