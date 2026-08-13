/**
 * @gatedflow/engine — framework-agnostic gated workflow engine core.
 *
 * The engine contains no LLM, no orchestrator imports, and no direct I/O.
 * "Must verify / confirm / review" rules live in control flow (gates) that
 * no agent can bypass; every external capability arrives through the small
 * interfaces in {@link runtime.EngineServices}.
 */

export * from './types.js'
export type { WorkflowRuntimeState } from './types.js'
export * from './errors.js'
export * from './validate.js'
export * from './condition.js'
export * from './expand.js'
export {
  WorkflowRuntime,
  type AgentExecutor,
  type AgentRunResult,
  type AuditSink,
  type DeadlineTimer,
  type EngineServices,
  type ShellRequest,
  type ShellRunner,
  type ShellRunResult,
  type StartOptions,
  type StepContext,
  type WorkflowStore,
} from './runtime.js'
