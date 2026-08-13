/**
 * Workflow runtime: the deterministic state machine that executes an
 * expanded workflow until a gate, completion, or failure.
 *
 * Dependency inversion — every side effect arrives through {@link EngineServices}:
 *
 * - {@link ShellRunner}   executes shell steps (adapter supplies the real one)
 * - {@link AgentExecutor} executes delegate/resume steps (optional; adapters
 *   without an agent backend get a loud error when such a step is reached)
 * - {@link WorkflowStore} persists snapshots (engine calls `save` on every
 *   transition; the adapter owns the medium)
 * - {@link DeadlineTimer} arms gate deadlines (disposer-based)
 *
 * Zero-mutation discipline (gatedflow root constraint 3): workflow state is
 * only mutated by engine methods driven by explicit external decisions
 * (`run`, `decide`, `advance`, `kill`). There is no API for an orchestrator
 * to rewrite step outputs, params, or routing.
 */

import { DecisionMismatchError, GatedflowError } from './errors.js'
import { evalCondition, substituteRuntime } from './condition.js'
import { expandDynamic } from './expand.js'
import type {
  AdvanceDecision,
  AgentDelegateStepParams,
  AgentResumeStepParams,
  AtomicSpec,
  AuditRecord,
  ExpandedStep,
  ExpandedWorkflow,
  Gate,
  GateDecision,
  JsonValue,
  RouteValue,
  ShellStepParams,
  SubflowRegistry,
  WorkflowRuntimeState,
  WorkflowSnapshot,
  WorkflowStatus,
} from './types.js'

export interface ShellRequest {
  command: string
  workdir?: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface ShellRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  stdoutSpill: string | null
  stderrSpill: string | null
}

export interface ShellRunner {
  run(request: ShellRequest): Promise<ShellRunResult>
}

export interface StepContext {
  workflowId: string
  workspaceRoot: string
  stepOutputs: Record<string, JsonValue>
}

export interface AgentRunResult {
  completed: boolean
  output: JsonValue
  error?: string | null
  /**
   * The adapter signals run cancellation. Cancellation is a pause, never a
   * failure (the same D6 contract shell steps honor): the engine records the
   * partial output and pauses the workflow; `advance()` without a decision
   * resumes the step in place.
   */
  aborted?: boolean
}

/** Executor for agent steps; optional — see {@link EngineServices}. */
export interface AgentExecutor {
  delegate(params: AgentDelegateStepParams, context: StepContext, signal?: AbortSignal): Promise<AgentRunResult>
  resume(params: AgentResumeStepParams, context: StepContext, signal?: AbortSignal): Promise<AgentRunResult>
}

export interface WorkflowStore {
  save(state: WorkflowRuntimeState): Promise<void>
}

/** Audit sink: the engine emits typed records; the adapter batches/durably appends them. */
export type AuditSink = (workflowId: string, record: AuditRecord) => void | Promise<void>

/** Disposer-based timer abstraction (setTimeout in adapters). */
export interface DeadlineTimer {
  set(milliseconds: number, callback: () => void): () => void
}

export interface EngineServices {
  registry: SubflowRegistry
  shell: ShellRunner
  store: WorkflowStore
  timer: DeadlineTimer
  /** Optional agent backend; agent steps fail loudly without one. */
  agent?: AgentExecutor
  audit?: AuditSink
  now?: () => number
  /** Gate deadline when a step does not set `deadline_secs` (default 1800). */
  defaultGateDeadlineSecs?: number
  defaultShellTimeoutMs?: number
}

export interface StartOptions {
  workflowId?: string
  atomics: AtomicSpec[]
  workspaceRoot?: string
}

const DEFAULT_GATE_DEADLINE_SECS = 1800
const DEFAULT_SHELL_TIMEOUT_MS = 120000
const EXPECT_TIMEOUT_MS = 60000

function makeWorkflowId(now: number): string {
  return `wf-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

function capText(text: string | null | undefined, max: number): string {
  const s = String(text ?? '')
  return s.length > max ? s.slice(-max) : s
}

export class WorkflowRuntime {
  readonly workflowId: string
  readonly workspaceRoot: string
  readonly steps: Record<string, ExpandedStep>
  readonly stepOrder: string[]
  readonly wrapped: boolean

  private status: WorkflowStatus = 'running'
  private currentStep: string
  private readonly completedSteps: string[] = []
  private readonly stepOutputs: Record<string, JsonValue> = {}
  private readonly retryCounts: Record<string, number> = {}
  private pending: 'retry' | null = null
  private gate: Gate | null = null
  private error: string | null = null
  private note: string | null = null
  private decided = false
  private disposed = false
  private deadlineDisposer: (() => void) | null = null
  private opChain: Promise<unknown> = Promise.resolve()
  private looping = false
  private readonly createdAt: number
  private updatedAt: number

  private constructor(
    private readonly services: EngineServices,
    expanded: ExpandedWorkflow,
    options: { workflowId: string; workspaceRoot: string },
  ) {
    const now = services.now?.() ?? Date.now()
    this.workflowId = options.workflowId ?? makeWorkflowId(now)
    this.workspaceRoot = options.workspaceRoot ?? '.'
    this.steps = expanded.steps
    this.stepOrder = expanded.stepOrder
    this.wrapped = expanded.wrapped
    this.currentStep = expanded.entry
    this.createdAt = now
    this.updatedAt = now
  }

  /** Expand atomics and start a workflow: persists, audits, then runs. */
  static async start(services: EngineServices, options: StartOptions): Promise<WorkflowRuntime> {
    const expanded = expandDynamic(options.atomics, services.registry)
    const now = services.now?.() ?? Date.now()
    const runtime = new WorkflowRuntime(services, expanded, {
      workflowId: options.workflowId ?? makeWorkflowId(now),
      workspaceRoot: options.workspaceRoot ?? '.',
    })
    await runtime.persist()
    await runtime.emit('start', {
      atomics: options.atomics.map((a) => ({ name: (a as { name?: string }).name ?? null, type: (a as { type?: string }).type ?? null })),
      wrapped_pre_start: expanded.wrapped,
      steps: expanded.stepOrder.length,
    })
    await runtime.run()
    return runtime
  }

  /**
   * Rebuild a runtime from a persisted state record (adapter reconcile).
   * `running` states restore as `paused` (their process is gone); terminal
   * states restore verbatim. No step executes on restore.
   */
  static restore(services: EngineServices, state: WorkflowRuntimeState): WorkflowRuntime {
    const expanded: ExpandedWorkflow = { steps: state.steps, stepOrder: state.step_order, entry: state.current_step, wrapped: state.wrapped }
    const runtime = new WorkflowRuntime(services, expanded, { workflowId: state.workflow_id, workspaceRoot: state.workspace_root })
    runtime.status = state.status === 'running' ? 'paused' : state.status
    runtime.currentStep = state.current_step
    runtime.completedSteps.push(...state.completed_steps)
    for (const [key, value] of Object.entries(state.step_outputs)) runtime.stepOutputs[key] = value
    for (const [key, value] of Object.entries(state.retry_counts)) runtime.retryCounts[key] = value
    runtime.pending = state.pending
    runtime.gate = state.status === 'running' ? null : state.gate
    runtime.error = state.error
    runtime.note = state.status === 'running' ? 'reconciled: orphaned running workflow paused on restore' : state.note
    runtime.updatedAt = state.updated_at
    return runtime
  }

  // ------------------------------------------------------------------ state

  /** JSON-safe, owned snapshot for persistence and tool returns. */
  snapshot(): WorkflowSnapshot {
    return {
      workflow_id: this.workflowId,
      status: this.status,
      current_step: this.currentStep,
      completed_steps: [...this.completedSteps],
      step_outputs: JSON.parse(JSON.stringify(this.stepOutputs)) as Record<string, JsonValue>,
      retry_counts: JSON.parse(JSON.stringify(this.retryCounts)) as Record<string, number>,
      pending: this.pending,
      gate: this.gate === null ? null : JSON.parse(JSON.stringify(this.gate)) as Gate,
      error: this.error,
      note: this.note,
      workspace_root: this.workspaceRoot,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    }
  }

  outputs(): Record<string, JsonValue> {
    return JSON.parse(JSON.stringify(this.stepOutputs)) as Record<string, JsonValue>
  }

  isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'failed'
  }

  getStatus(): WorkflowStatus {
    return this.status
  }

  // --------------------------------------------------------------- actions

  /**
   * Run the tick loop from the current step until a gate pause, terminal
   * state, or signal abort. Aborts pause — never fail (D6/stop semantics).
   */
  run(signal?: AbortSignal): Promise<WorkflowSnapshot> {
    return this.serialize(async () => {
      if (this.disposed) return this.snapshot()
      await this.loop(signal)
      return this.snapshot()
    })
  }

  /**
   * Apply a human gate decision. The engine records `source` so audits can
   * distinguish panel decisions from anything else.
   */
  decide(decision: GateDecision, reason?: string, source = 'panel'): Promise<WorkflowSnapshot> {
    return this.serialize(async () => {
      if (this.disposed) throw new GatedflowError('ENGINE_ERROR', 'workflow is disposed')
      if (this.status !== 'paused') {
        throw new DecisionMismatchError(`workflow is not paused (${this.status})`)
      }
      const step = this.steps[this.currentStep]
      if (step === undefined || step.type !== 'interrupt') {
        throw new DecisionMismatchError(`current step is not an interrupt gate (${this.currentStep})`)
      }
      if (decision !== 'approve' && decision !== 'reject') {
        throw new DecisionMismatchError(`gate decision must be approve/reject (got "${decision}")`)
      }
      if (this.decided) {
        throw new DecisionMismatchError('this gate has already been decided')
      }
      this.decided = true
      this.clearDeadline()
      this.stepOutputs[this.currentStep] = { decision, reason: reason ?? null, source }
      this.gate = null
      this.status = 'running'
      await this.emit('gate_decision', { step: this.currentStep, decision, source })
      await this.route(step, decision === 'approve' ? step.on_approve : step.on_reject)
      await this.loop(undefined)
      return this.snapshot()
    })
  }

  /**
   * Advance a paused workflow. `retry` re-runs a failed step (prior outputs
   * kept); `handoff_complete`/`handoff_fail` return the delegated result; an
   * omitted decision resumes the current step after an interruption.
   */
  advance(decision?: AdvanceDecision, result?: JsonValue, reason?: string): Promise<WorkflowSnapshot> {
    return this.serialize(async () => {
      if (this.disposed) throw new GatedflowError('ENGINE_ERROR', 'workflow is disposed')
      if (this.isTerminal()) return this.snapshot()
      if (this.status !== 'paused') return this.snapshot()

      const step = this.steps[this.currentStep]
      if (step === undefined) {
        this.fail('missing step: ' + this.currentStep, 'failed')
        return this.snapshot()
      }

      if (this.pending === 'retry') {
        if (decision !== 'retry') {
          throw new DecisionMismatchError(`step failed and awaits retry; expected decision "retry" (got ${decision ?? 'none'})`)
        }
        this.clearDeadline()
        this.pending = null
        this.status = 'running'
        this.retryCounts[this.currentStep] = (this.retryCounts[this.currentStep] ?? 0) + 1
        await this.emit('retry', { step: this.currentStep, count: this.retryCounts[this.currentStep] ?? 1 })
        await this.loop(undefined)
        return this.snapshot()
      }

      if (step.type === 'interrupt') {
        throw new DecisionMismatchError('interrupt gates are decided by the human through the gate UI, not by advance()')
      }

      if (step.type === 'handoff') {
        if (decision !== 'handoff_complete' && decision !== 'handoff_fail') {
          throw new DecisionMismatchError(`handoff gate expects handoff_complete/handoff_fail (got ${decision ?? 'none'})`)
        }
        this.clearDeadline()
        const store: Record<string, JsonValue> = { ...(this.stepOutputs[this.currentStep] as Record<string, JsonValue> | undefined) }
        if (decision === 'handoff_complete') {
          store.result = result ?? null
        } else {
          store.fail_reason = reason ?? null
        }
        this.stepOutputs[this.currentStep] = store
        this.status = 'running'
        this.gate = null
        await this.emit('handoff', { step: this.currentStep, decision })
        await this.route(step, decision === 'handoff_complete' ? step.on_success : step.on_failure)
        await this.loop(undefined)
        return this.snapshot()
      }

      if (decision !== undefined) {
        throw new DecisionMismatchError(`paused reason does not accept decision "${decision}" (step type ${step.type}, pending ${this.pending ?? 'none'})`)
      }

      // Omitted decision on an interrupted step: resume the current step.
      this.clearDeadline()
      this.status = 'running'
      this.gate = null
      await this.emit('resume', { step: this.currentStep })
      await this.loop(undefined)
      return this.snapshot()
    })
  }

  /** Terminate the workflow (human-driven, zero-mutation discipline). */
  kill(reason?: string): Promise<WorkflowSnapshot> {
    return this.serialize(async () => {
      this.clearDeadline()
      this.fail(`killed: ${reason ?? 'user requested'}`, 'killed')
      return this.snapshot()
    })
  }

  /** Mark the runtime disposed; no further state changes are accepted. */
  dispose(): void {
    this.disposed = true
    this.clearDeadline()
  }

  // ------------------------------------------------------------------ loop

  private async loop(signal?: AbortSignal): Promise<void> {
    if (this.looping || this.disposed) return
    this.looping = true
    try {
      while (this.status === 'running') {
        if (signal?.aborted) {
          this.status = 'paused'
          this.pending = null
          this.note = 'interrupted (/stop or cancelled); advance() without a decision resumes this step'
          await this.emit('interrupted', { step: this.currentStep })
          break
        }
        const step = this.steps[this.currentStep]
        if (step === undefined) {
          this.fail('missing step: ' + this.currentStep, 'failed')
          break
        }
        await this.emit('step_start', { step: this.currentStep, type: step.type })
        const outcome = await this.execStep(step, signal)
        if (outcome.terminal || outcome.paused) break
      }
    } catch (error) {
      this.fail(`engine error: ${error instanceof Error ? error.message : String(error)}`, 'failed')
    } finally {
      this.looping = false
      this.updatedAt = this.services.now?.() ?? Date.now()
    }
    await this.persist()
  }

  private async execStep(step: ExpandedStep, signal?: AbortSignal): Promise<{ terminal?: boolean; paused?: boolean }> {
    switch (step.type) {
      case 'shell':
        return this.execShell(step, signal)
      case 'interrupt': {
        const params = step.params
        const message = substituteRuntime(typeof params.message === 'string' ? params.message : 'Please confirm to continue.', this.stepOutputs)
        const header = typeof params.header === 'string' ? params.header : 'gatedflow gate'
        const gate: Gate = { checkpoint_type: 'user_confirm', message, header, step: step.id }
        await this.pause('gate_pending', gate)
        return { paused: true }
      }
      case 'handoff': {
        const params = step.params
        const hint = substituteRuntime(typeof params.task_hint === 'string' ? params.task_hint : '', this.stepOutputs)
        const gate: Gate = { checkpoint_type: 'handoff', task_hint: hint, inputs: params.inputs ?? null, step: step.id }
        await this.pause('handoff', gate)
        return { paused: true }
      }
      case 'conditional': {
        const params = step.params
        const expr = substituteRuntime(typeof params.expr === 'string' ? params.expr : '', this.stepOutputs)
        let result: boolean
        try {
          result = evalCondition(expr, this.stepOutputs)
        } catch {
          result = false
        }
        this.stepOutputs[step.id] = { result, expr }
        await this.route(step, result ? step.on_true : step.on_false)
        return {}
      }
      case 'agent_delegate': {
        const executor = this.services.agent
        if (executor === undefined) {
          throw new GatedflowError('ENGINE_ERROR', `step ${step.id} is agent_delegate but no agent executor is configured`)
        }
        const result = await executor.delegate(step.params as unknown as AgentDelegateStepParams, this.context(), signal)
        this.stepOutputs[step.id] = result.output
        if (result.aborted === true) return this.pauseInterrupted(step.id)
        await this.emit(result.completed ? 'step_success' : 'step_failed', { step: step.id })
        if (!result.completed) {
          if (step.params.pause_on_failure === true) {
            await this.pause('retry', { checkpoint_type: 'retry', message: 'step failed; repair the environment, then retry', step: step.id })
            return { paused: true }
          }
          await this.route(step, step.on_failure ?? 'abort')
          return {}
        }
        await this.route(step, step.on_success)
        return {}
      }
      case 'agent_resume': {
        const executor = this.services.agent
        if (executor === undefined) {
          throw new GatedflowError('ENGINE_ERROR', `step ${step.id} is agent_resume but no agent executor is configured`)
        }
        const result = await executor.resume(step.params as unknown as AgentResumeStepParams, this.context(), signal)
        this.stepOutputs[step.id] = result.output
        if (result.aborted === true) return this.pauseInterrupted(step.id)
        await this.emit(result.completed ? 'step_success' : 'step_failed', { step: step.id })
        if (!result.completed) {
          this.fail('agent_resume failed: ' + (result.error ?? 'unknown'), 'failed')
          return { terminal: true }
        }
        await this.route(step, step.on_success)
        return {}
      }
      case 'done':
        this.status = 'completed'
        await this.emit('completed', {})
        return { terminal: true }
      default:
        throw new GatedflowError('ENGINE_ERROR', `unknown step type: ${String((step as { type: string }).type)}`)
    }
  }

  private async execShell(step: ExpandedStep, signal?: AbortSignal): Promise<{ terminal?: boolean; paused?: boolean }> {
    const params = step.params as unknown as ShellStepParams
    const command = substituteRuntime(params.command ?? '', this.stepOutputs)
    const workdir = substituteRuntime(params.workdir ?? this.workspaceRoot, this.stepOutputs)
    const maxAttempts = 1 + Math.max(0, Number(params.max_retries) || 0)
    let attempt = 0
    let last: Record<string, JsonValue> | null = null
    let abortedRun = false

    while (attempt < maxAttempts && !abortedRun) {
      attempt++
      const result = await this.services.shell.run({
        command,
        workdir,
        timeoutMs: Number(params.timeout_ms) > 0 ? Number(params.timeout_ms) : (this.services.defaultShellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS),
        signal,
      })
      last = {
        attempt,
        exit_code: result.exitCode,
        stdout: capText(result.stdout, 2000),
        stderr: capText(result.stderr, 2000),
        stdout_spill: result.stdoutSpill,
        stderr_spill: result.stderrSpill,
        timed_out: result.timedOut,
        aborted: result.aborted,
      }
      if (result.aborted) {
        abortedRun = true
        break
      }
      let success = result.exitCode === 0 && !result.timedOut
      if (success && typeof params.expect === 'string') {
        const expect = await this.services.shell.run({
          command: substituteRuntime(params.expect, this.stepOutputs),
          workdir,
          timeoutMs: EXPECT_TIMEOUT_MS,
          signal,
        })
        last.expect_exit_code = expect.exitCode
        last.expect_stdout = capText(expect.stdout, 2000)
        if (expect.aborted) {
          last.aborted = true
          abortedRun = true
          break
        }
        success = expect.exitCode === 0 && !expect.timedOut
      }
      if (success) break
    }

    this.stepOutputs[step.id] = last ?? {}

    if (abortedRun) {
      return this.pauseInterrupted(step.id)
    }

    const succeeded =
      last !== null &&
      last.exit_code === 0 &&
      (typeof params.expect !== 'string' || last.expect_exit_code === 0) &&
      last.timed_out !== true

    if (succeeded) {
      await this.emit('step_success', { step: step.id, attempts: attempt })
      await this.route(step, step.on_success)
      return {}
    }

    if (params.pause_on_failure === true) {
      await this.emit('step_failed_pause', { step: step.id })
      await this.pause('retry', { checkpoint_type: 'retry', message: 'step failed; repair the environment, then retry', step: step.id })
      return { paused: true }
    }

    await this.emit('step_failed', { step: step.id })
    await this.route(step, step.on_failure ?? 'abort')
    return {}
  }

  // ---------------------------------------------------------------- shared

  private context(): StepContext {
    return { workflowId: this.workflowId, workspaceRoot: this.workspaceRoot, stepOutputs: this.stepOutputs }
  }

  private async route(step: ExpandedStep, target: RouteValue | undefined): Promise<void> {
    this.completedSteps.push(step.id)
    await this.emit('step_done', { step: step.id, type: step.type })
    if (target === 'done') {
      this.currentStep = 'done'
      this.status = 'running'
      return
    }
    if (target === 'abort') {
      this.fail(`abort route: step ${step.id}`, 'failed')
      return
    }
    if (typeof target === 'string' && this.steps[target] !== undefined) {
      this.currentStep = target
      this.status = 'running'
      return
    }
    this.fail(`step ${step.id} route target not found: ${String(target)}`, 'failed')
  }

  /**
   * Interruption is a pause, never a failure: partial outputs are kept and
   * the step resumes in place on `advance()` without a decision.
   */
  private async pauseInterrupted(stepId: string): Promise<{ paused: true }> {
    this.status = 'paused'
    this.pending = null
    this.gate = null
    this.note = `interrupted at ${stepId} (/stop or cancelled); advance() without a decision resumes this step`
    await this.emit('interrupted', { step: stepId })
    return { paused: true }
  }

  private async pause(kind: 'gate_pending' | 'handoff' | 'retry', gate: Gate | null): Promise<void> {
    this.status = 'paused'
    this.pending = kind === 'retry' ? 'retry' : null
    this.gate = gate
    this.decided = false
    this.clearDeadline()
    const step = this.steps[this.currentStep]
    const seconds =
      Number((step?.params as { deadline_secs?: number } | undefined)?.deadline_secs) > 0
        ? Number((step?.params as { deadline_secs?: number }).deadline_secs)
        : (this.services.defaultGateDeadlineSecs ?? DEFAULT_GATE_DEADLINE_SECS)
    this.deadlineDisposer = this.services.timer.set(seconds * 1000, () => {
      if (this.status === 'paused' && !this.disposed) {
        this.fail(`gate deadline exceeded (${seconds}s): ${this.currentStep}`, 'gate_timeout')
        void this.persist()
      }
    })
    await this.emit('gate_pause', { kind, step: this.currentStep })
  }

  private clearDeadline(): void {
    if (this.deadlineDisposer !== null) {
      this.deadlineDisposer()
      this.deadlineDisposer = null
    }
  }

  private fail(message: string, event: 'failed' | 'killed' | 'gate_timeout'): void {
    this.status = 'failed'
    this.error = message
    this.gate = null
    this.clearDeadline()
    void this.emit(event, { step: this.currentStep, reason: message })
  }

  private async emit(event: AuditRecord['event'], data: JsonValue): Promise<void> {
    const sink = this.services.audit
    if (sink === undefined) return
    const record: AuditRecord = { ts: new Date().toISOString(), event, data }
    try {
      await sink(this.workflowId, record)
    } catch {
      // Audit failures never break workflow execution.
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.services.store.save({
        ...this.snapshot(),
        steps: this.steps,
        step_order: this.stepOrder,
        wrapped: this.wrapped,
      })
    } catch {
      // Persistence failures never break workflow execution.
    }
  }

  /** Serialize state-mutating operations per workflow (concurrent calls queue). */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(operation)
    this.opChain = run.catch(() => undefined)
    return run
  }
}
