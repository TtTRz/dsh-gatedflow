/**
 * Domain types for the gatedflow engine core.
 *
 * The engine core is deliberately framework-agnostic: it contains no LLM
 * calls, no orchestrator imports, and no I/O of its own. Every external
 * capability (shell execution, persistence, timers) arrives through the
 * small interfaces in {@link runtime}.
 */

/** Lossless JSON value used across DSL data and step outputs. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** User-writable step types. `done` is engine-internal and not user-writable. */
export const STEP_TYPES = [
  'shell',
  'interrupt',
  'handoff',
  'conditional',
  'agent_delegate',
  'agent_resume',
] as const

export type StepType = (typeof STEP_TYPES)[number]

/**
 * Routing outcome fields per step type. Different step semantics keep
 * different outcome words (gatedflow D2): `interrupt` is a human decision,
 * `shell` is command success/failure — collapsing them would lose meaning.
 */
export const ROUTE_KEYS = {
  shell: ['on_success', 'on_failure'],
  interrupt: ['on_approve', 'on_reject'],
  handoff: ['on_success', 'on_failure'],
  agent_delegate: ['on_success', 'on_failure'],
  agent_resume: ['on_success'],
  conditional: ['on_true', 'on_false'],
} as const satisfies Record<StepType, readonly string[]>

export type RouteKey = (typeof ROUTE_KEYS)[StepType][number]

/**
 * A routing target: the next step's local id, or one of the engine words
 * `next` (into the following atomic block, wired at expansion time),
 * `done` (complete) or `abort` (fail).
 */
export type RouteValue = string

export interface ShellStepParams {
  /** Bash command to run. */
  command: string
  /** Objective verification command; exit 0 required for step success. */
  expect?: string
  /** Working directory override (falls back to workspace_root). */
  workdir?: string
  /** Command timeout in milliseconds (default 120000). */
  timeout_ms?: number
  /** Automatic retry attempts before failing (default 0). */
  max_retries?: number
  /** On failure, pause for human repair instead of routing on_failure. */
  pause_on_failure?: boolean
  /** Gate/failure-pause deadline in seconds (default 1800). */
  deadline_secs?: number
}

export interface InterruptStepParams {
  /** Question shown to the human. */
  message?: string
  /** Question header shown by the gate UI. */
  header?: string
  /** Deadline in seconds before the paused gate auto-fails. */
  deadline_secs?: number
}

export interface HandoffStepParams {
  /** Task description handed to the orchestrating agent. */
  task_hint: string
  /** Optional structured inputs handed along with the task. */
  inputs?: JsonValue
  deadline_secs?: number
}

export interface ConditionalStepParams {
  /** Deterministic expression over structured step outputs (no NL semantics). */
  expr: string
  deadline_secs?: number
}

export interface AgentDelegateStepParams {
  prompt: string
  workdir?: string
  timeout_ms?: number
  deadline_secs?: number
}

export interface AgentResumeStepParams {
  session: string
  feedback: string
  deadline_secs?: number
}

/** Discriminated step definitions (the declarative DSL surface). */
interface StepDefBase {
  id: string
  params?: object
}

export interface ShellStepDef extends StepDefBase {
  type: 'shell'
  params?: ShellStepParams
  on_success: RouteValue
  on_failure: RouteValue
}

export interface InterruptStepDef extends StepDefBase {
  type: 'interrupt'
  params?: InterruptStepParams
  on_approve: RouteValue
  on_reject: RouteValue
}

export interface HandoffStepDef extends StepDefBase {
  type: 'handoff'
  params?: HandoffStepParams
  on_success: RouteValue
  on_failure: RouteValue
}

export interface ConditionalStepDef extends StepDefBase {
  type: 'conditional'
  params?: ConditionalStepParams
  on_true: RouteValue
  on_false: RouteValue
}

export interface AgentDelegateStepDef extends StepDefBase {
  type: 'agent_delegate'
  params?: AgentDelegateStepParams
  on_success: RouteValue
  on_failure: RouteValue
}

export interface AgentResumeStepDef extends StepDefBase {
  type: 'agent_resume'
  params?: AgentResumeStepParams
  on_success: RouteValue
}

export type StepDef =
  | ShellStepDef
  | InterruptStepDef
  | HandoffStepDef
  | ConditionalStepDef
  | AgentDelegateStepDef
  | AgentResumeStepDef

export interface ParamSpec {
  required?: boolean
  description?: string
  default?: JsonValue
}

export interface ExportSpec {
  /** Local step + field the export reads from, e.g. `"code.session_name"`. */
  from: string
  description?: string
}

/** A named, declarative, reusable workflow fragment (data, not code). */
export interface SubflowDef {
  name: string
  description?: string
  keywords?: string[]
  params?: Record<string, ParamSpec>
  exports?: Record<string, ExportSpec>
  steps: StepDef[]
}

/** One `atomics` entry: a reference to a named subflow. */
export interface SubflowRef {
  name: string
  params?: Record<string, JsonValue>
}

/** One `atomics` entry: an ad-hoc inline step (dynamic path). */
export interface InlineSpec {
  type: StepType
  params?: Record<string, JsonValue>
  [key: string]: JsonValue | StepType | undefined
}

export type AtomicSpec = SubflowRef | InlineSpec

/** Registry abstraction over builtin + file-loaded subflows. */
export interface SubflowRegistry {
  get(name: string): SubflowDef | undefined
  names(): string[]
}

/** Step types at runtime: user-writable {@link StepType}s plus the engine-internal `done`. */
export type RuntimeStepType = StepType | 'done'

/** A step after expansion: globally unique id, prefix-scoped routes. */
export interface ExpandedStep {
  id: string
  type: RuntimeStepType
  params: Record<string, JsonValue>
  on_success?: RouteValue
  on_failure?: RouteValue
  on_approve?: RouteValue
  on_reject?: RouteValue
  on_true?: RouteValue
  on_false?: RouteValue
}

export interface ExpandedWorkflow {
  steps: Record<string, ExpandedStep>
  stepOrder: string[]
  entry: string
  /** True when a pre_start_gate was wrapped (dynamic path ②). */
  wrapped: boolean
}

export type WorkflowStatus = 'running' | 'paused' | 'completed' | 'failed'

/** Decisions the orchestrator may advance a paused workflow with. */
export type AdvanceDecision = 'retry' | 'handoff_complete' | 'handoff_fail'

/** Human decisions on an interrupt gate. */
export type GateDecision = 'approve' | 'reject'

export interface Gate {
  checkpoint_type: 'user_confirm' | 'handoff' | 'retry'
  message?: string
  header?: string
  task_hint?: string
  inputs?: JsonValue
  step: string
}

/** Persisted, JSON-safe snapshot of one workflow. */
export interface WorkflowSnapshot {
  workflow_id: string
  status: WorkflowStatus
  current_step: string
  completed_steps: string[]
  step_outputs: Record<string, JsonValue>
  retry_counts: Record<string, number>
  pending: 'retry' | null
  gate: Gate | null
  error: string | null
  note: string | null
  workspace_root: string
  created_at: number
  updated_at: number
}

/** Full persisted record: snapshot plus the expanded definition, so an adapter can restore the runtime. */
export interface WorkflowRuntimeState extends WorkflowSnapshot {
  steps: Record<string, ExpandedStep>
  step_order: string[]
  wrapped: boolean
}

export type AuditEventName =
  | 'start'
  | 'step_start'
  | 'step_success'
  | 'step_failed'
  | 'step_failed_pause'
  | 'step_done'
  | 'gate_pause'
  | 'gate_decision'
  | 'gate_timeout'
  | 'handoff'
  | 'retry'
  | 'resume'
  | 'interrupted'
  | 'killed'
  | 'reconcile'
  | 'completed'
  | 'failed'

export interface AuditRecord {
  ts: string
  event: AuditEventName
  data: JsonValue
}
