/**
 * DeepSeek Harness agent backend for the gatedflow engine's agent steps.
 *
 * `agent_delegate` establishes one CONTINUABLE background child
 * (`ctx.subagents.startContinuable`) — the durable-child mode the deployment's
 * own delegation tools use for background work — and waits for its initial
 * turn to settle. The child id is recorded in the step output so a later
 * `agent_resume` can continue the SAME child session with feedback
 * (`ctx.subagents.followup`) and wait for that next turn.
 *
 * Continuable turns have no `SubagentRun`, so settlement is observed through
 * the `subagent/start` / `subagent/end` lifecycle pair. Both are
 * scope-dispatched to the delegating parent, and dsh-scope admits listeners
 * up the chain — a listener on the enclosing preset context receives every
 * descendant agent's events, which is exactly what a standing composition is
 * for. The listener is registered before the child operation and disposed
 * when the step settles, so no epoch can be missed and nothing leaks.
 *
 * Cancellation is honored two ways, both mapped onto the engine's D6 rule
 * (abort pauses, never fails): the workflow's run signal and the calling
 * tool's `exec.signal` are fused into every child operation, and a step that
 * is cancelled mid-turn interrupts the child (best effort) and reports
 * `aborted: true` so the engine pauses instead of routing `on_failure`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ContinuableStart,
  CoordinatorMessageSource,
  SubagentRunEndInfo,
  SubagentRunInfo,
} from '@deepseek-ai/dsh-subagent'
import {
  substituteRuntime,
  type AgentDelegateStepParams,
  type AgentExecutor,
  type AgentResumeStepParams,
  type AgentRunResult,
  type JsonValue,
  type StepContext,
} from '@gatedflow/engine'

/** Disposer-based timer (the adapter's `ctx.timeout` wrapper). */
export type AgentTimer = (callback: () => void, milliseconds: number) => () => void

export interface DshAgentExecutorOptions {
  ctx: Context
  /** `ctx.subagents` provider name used for delegate and resume steps. */
  provider: string
  timer: AgentTimer
}

/** One settled child turn, reduced from the lifecycle pair. */
interface EpochSettlement {
  stopReason: string
  output: ContentBlock[]
}

/** Marker: the wait ended because the run/tool was cancelled, not failed. */
class CancelledError extends Error {
  constructor() {
    super('agent step cancelled')
    this.name = 'CancelledError'
  }
}

function noop(): void {}

function textOf(output: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of output) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

function stopReasonMessage(reason: string): string {
  switch (reason) {
    case 'completed': return 'completed'
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${reason})`
  }
}

/** Fuse zero or more signals into one that fires when any fires. */
function fuseAborts(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined && !signal.aborted)
  if (live.length === 1) return live[0]!
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  for (const signal of live) signal.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

/** Effective per-step timeout: `timeout_ms` first, else `deadline_secs`. */
function stepTimeoutMs(timeoutMs: number | undefined, deadlineSecs: number | undefined): number | undefined {
  if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs
  if (typeof deadlineSecs === 'number' && deadlineSecs > 0) return deadlineSecs * 1000
  return undefined
}

/**
 * Per-step observer over the `subagent/start` / `subagent/end` lifecycle pair.
 * Listeners are registered on the enclosing context at construction (before
 * the child operation starts) and removed by {@link dispose}.
 *
 * Exported for tests; workflow code should use {@link DshAgentExecutor}.
 */
export class EpochWaiter {
  private readonly starts: SubagentRunInfo[] = []
  private readonly ends: SubagentRunEndInfo[] = []
  private notified: (() => void) | null = null
  private readonly offStart: () => void
  private readonly offEnd: () => void

  constructor(ctx: Context) {
    this.offStart = ctx.on('subagent/start', (info) => {
      this.starts.push(info)
      this.notified?.()
    })
    this.offEnd = ctx.on('subagent/end', (info) => {
      this.ends.push(info)
      this.notified?.()
    })
  }

  dispose(): void {
    this.offStart()
    this.offEnd()
  }

  /** The first settled epoch of a brand-new child (the delegate's initial turn). */
  awaitFirstEnd(childId: string, timeoutMs: number | undefined, signal: AbortSignal | undefined, timer: AgentTimer): Promise<EpochSettlement> {
    return this.awaitSettle(childId, 'first', timeoutMs, signal, timer)
  }

  /** The next epoch started after this call begins (the resume's follow-up turn). */
  awaitNextEpoch(childId: string, timeoutMs: number | undefined, signal: AbortSignal | undefined, timer: AgentTimer): Promise<EpochSettlement> {
    return this.awaitSettle(childId, 'next', timeoutMs, signal, timer)
  }

  private findMatch(childId: string, mode: 'first' | 'next', startBoundary: number, endBoundary: number): EpochSettlement | null {
    if (mode === 'first') {
      for (let i = endBoundary; i < this.ends.length; i++) {
        const end = this.ends[i]!
        if (String(end.id) === childId) {
          return { stopReason: end.stopReason, output: end.lastAssistantMessage ?? [] }
        }
      }
      return null
    }
    // Pair the epoch by runId: the next start for this child, then its end.
    for (let i = startBoundary; i < this.starts.length; i++) {
      const start = this.starts[i]!
      if (String(start.id) !== childId) continue
      for (const end of this.ends) {
        if (String(end.runId) === String(start.runId)) {
          return { stopReason: end.stopReason, output: end.lastAssistantMessage ?? [] }
        }
      }
      // The epoch started but has not settled yet; keep waiting.
      return null
    }
    return null
  }

  private awaitSettle(childId: string, mode: 'first' | 'next', timeoutMs: number | undefined, signal: AbortSignal | undefined, timer: AgentTimer): Promise<EpochSettlement> {
    const startBoundary = this.starts.length
    const endBoundary = this.ends.length
    const match = (): EpochSettlement | null => this.findMatch(childId, mode, startBoundary, endBoundary)
    const found = match()
    if (found !== null) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      let settled = false
      let offTimer = noop
      const cleanup = (): void => {
        this.notified = null
        offTimer()
        signal?.removeEventListener('abort', onAbort)
      }
      const done = (value: EpochSettlement): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => fail(new CancelledError())
      this.notified = () => {
        const hit = match()
        if (hit !== null) done(hit)
      }
      if (timeoutMs !== undefined) offTimer = timer(() => fail(new Error(`agent step timed out after ${timeoutMs} ms`)), timeoutMs)
      if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
      else if (signal?.aborted === true) fail(new CancelledError())
    })
  }
}

/**
 * The DSH `AgentExecutor`: continuable background children for
 * `agent_delegate`, `followup` turns for `agent_resume`.
 */
export class DshAgentExecutor implements AgentExecutor {
  private readonly ctx: Context
  private readonly provider: string
  private readonly timer: AgentTimer
  private parent: Agent | undefined
  private signal: AbortSignal | undefined

  constructor(options: DshAgentExecutorOptions) {
    this.ctx = options.ctx
    this.provider = options.provider
    this.timer = options.timer
  }

  /**
   * Rebind the calling identity before each engine run. A restored workflow
   * advances from a later tool call with a different `exec`; the engine keeps
   * one executor per runtime, so the identity must be re-bound per call.
   */
  bind(parent: Agent | undefined, signal: AbortSignal | undefined): void {
    this.parent = parent
    this.signal = signal
  }

  async delegate(params: AgentDelegateStepParams, context: StepContext, signal?: AbortSignal): Promise<AgentRunResult> {
    const parent = this.parent
    if (parent === undefined) return this.noCallingAgent()
    const subagents = this.ctx.subagents
    const provider = subagents.getProvider(this.provider)
    if (provider === undefined) {
      return { completed: false, output: { error: `subagent provider "${this.provider}" is not registered` }, error: `provider not registered: ${this.provider}` }
    }
    if (provider.prepareContinuable === undefined) {
      return { completed: false, output: { error: `subagent provider "${this.provider}" does not support continuable children (agent_delegate needs a resumable child)` }, error: 'provider lacks continuable support' }
    }

    const prompt = substituteRuntime(typeof params.prompt === 'string' ? params.prompt : '', context.stepOutputs)
    const fused = fuseAborts(signal, this.signal)
    const waiter = new EpochWaiter(this.ctx)
    let child: ContinuableStart
    try {
      child = await subagents.startContinuable({
        provider: this.provider,
        label: `gatedflow:${context.workflowId}`,
        request: { prompt: [{ type: 'text', text: prompt }], parent },
        signal: fused,
      })
    } catch (error) {
      waiter.dispose()
      return { completed: false, output: { error: String(error) }, error: String(error) }
    }
    return this.settle(waiter.awaitFirstEnd(String(child.childId), stepTimeoutMs(params.timeout_ms, params.deadline_secs), fused, this.timer), {
      child_id: String(child.childId),
    }, child.childId, parent, fused)
  }

  async resume(params: AgentResumeStepParams, context: StepContext, signal?: AbortSignal): Promise<AgentRunResult> {
    const parent = this.parent
    if (parent === undefined) return this.noCallingAgent()
    const session = substituteRuntime(typeof params.session === 'string' ? params.session : '', context.stepOutputs)
    if (session.length === 0) {
      return { completed: false, output: { error: 'agent_resume requires a session (the child_id recorded by an earlier agent_delegate)' }, error: 'missing session' }
    }
    const feedback = substituteRuntime(typeof params.feedback === 'string' ? params.feedback : '', context.stepOutputs)
    const fused = fuseAborts(signal, this.signal)
    const source: CoordinatorMessageSource = { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }
    const waiter = new EpochWaiter(this.ctx)
    try {
      await this.ctx.subagents.followup(parent, SessionId(session), [{ type: 'text', text: feedback }], { source, signal: fused })
    } catch (error) {
      waiter.dispose()
      return { completed: false, output: { error: String(error) }, error: String(error) }
    }
    return this.settle(waiter.awaitNextEpoch(session, stepTimeoutMs(undefined, params.deadline_secs), fused, this.timer), {
      session,
    }, SessionId(session), parent, fused)
  }

  private noCallingAgent(): AgentRunResult {
    return { completed: false, output: { error: 'no calling agent (exec.agent); agent steps require a tool execution context' }, error: 'no calling agent' }
  }

  private async settle(pending: Promise<EpochSettlement>, extra: Record<string, JsonValue>, childId: SessionId, parent: Agent, fused: AbortSignal): Promise<AgentRunResult> {
    try {
      const outcome = await pending
      const text = textOf(outcome.output)
      const completed = outcome.stopReason === 'completed'
      return {
        completed,
        output: { ...extra, text, stop_reason: outcome.stopReason },
        error: completed ? null : stopReasonMessage(outcome.stopReason),
      }
    } catch (error) {
      // Stop wasted work: interrupt the live child (accepted no-op when idle).
      this.ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
      if (error instanceof CancelledError || fused.aborted === true) {
        return { completed: false, aborted: true, output: { ...extra, aborted: true }, error: 'cancelled' }
      }
      return { completed: false, output: { ...extra, error: String(error) }, error: String(error) }
    }
  }
}
