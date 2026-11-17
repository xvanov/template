/**
 * Agents: a bounded tool-use loop over @repo/ai, where anything that would
 * CHANGE something becomes a proposal a person approves.
 *
 *   tool.ts       defineReadTool / defineWriteTool — what a tool is
 *   tools/        the demo tools (items); add yours, then list them in
 *   registry.ts   TOOLS
 *   loop.ts       the loop (pure: model + recorder injected)
 *   run.ts        startRun (API) / executeRun (the `agent.run` worker job)
 *   proposals.ts  createProposal / approveProposal / rejectProposal
 */
export {
  ConflictError,
  DomainRuleError,
  NotFoundError,
  isExpected,
} from "./errors";
export {
  classify,
  runLoop,
  SYSTEM_PROMPT,
  type LoopOptions,
  type LoopResult,
  type Model,
  type Recorder,
  type StepKind,
  type StopReason,
} from "./loop";
export {
  approveProposal,
  createProposal,
  rejectProposal,
  type ApproveResult,
  type Audit,
  type ProposalSource,
} from "./proposals";
export { readTool, TOOLS, toolByName, writeTool } from "./registry";
export {
  abandonStaleRuns,
  dbRecorder,
  executeRun,
  startRun,
  type ExecuteDeps,
  type ExecuteOutcome,
} from "./run";
export {
  defineReadTool,
  defineWriteTool,
  issuesLine,
  TOOL_NAME,
  toolSpec,
  type AgentTool,
  type ApplyContext,
  type ReadTool,
  type ToolContext,
  type WriteTool,
} from "./tool";
