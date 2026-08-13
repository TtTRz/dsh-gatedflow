import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo, SubagentRunInfo, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { DshAgentExecutor, EpochWaiter, type AgentTimer } from '../src/agent-executor.js'
import type { AgentDelegateStepParams, AgentResumeStepParams, StepContext } from '@gatedflow/engine'

// ------------------------------------------------------------- test doubles

function endInfo(id: string, runId: string, stopReason = 'completed', text = ''): SubagentRunEndInfo {
  return {
    runId,
    provider: 'spawn',
    id,
    local: true,
    stopReason,
    lastAssistantMessage: text.length > 0 ? [{ type: 'text', text }] : [],
  } as unknown as SubagentRunEndInfo
}

function startInfo(id: string, runId: string): SubagentRunInfo {
  return { runId, provider: 'spawn', id, local: true } as unknown as SubagentRunInfo
}

/** Event bus with the two lifecycle events the executor listens to. */
function mockEventBus() {
  const listeners = new Map<string, Array<(info: unknown) => void>>()
  const ctx = {
    on(name: string, cb: (info: unknown) => void) {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
      return () => {
        const index = list.indexOf(cb)
        if (index >= 0) list.splice(index, 1)
      }
    },
  }
  return {
    ctx: ctx as unknown as Context,
    emit(name: string, info: unknown): void {
      for (const cb of listeners.get(name) ?? []) cb(info)
    },
  }
}

function realTimer(): AgentTimer {
  return (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds)
    return () => clearTimeout(handle)
  }
}

/** Flush pending microtasks plus one macrotask (lets awaited promises settle). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface FakeSubagents {
  started: Array<{ provider: string; label: string; prompt: string }>
  followed: Array<{ childId: string; text: string }>
  interrupts: string[]
  providerExists: boolean
  failStart?: Error
  failFollowup?: Error
  childId: string
  runtime(): SubagentRuntime
}

function fakeSubagents(): FakeSubagents {
  const fake: FakeSubagents = {
    started: [],
    followed: [],
    interrupts: [],
    providerExists: true,
    childId: 'child-1',
    runtime(): SubagentRuntime {
      return {
        getProvider: (name: string) => (fake.providerExists ? ({ name, capabilities: {}, inheritsParentContext: false, prepareContinuable: async () => ({}) } as never) : undefined),
        startContinuable: async (spec: { provider: string; label: string; request: { prompt: Array<{ text: string }> } }) => {
          if (fake.failStart !== undefined) throw fake.failStart
          fake.started.push({ provider: spec.provider, label: spec.label, prompt: spec.request.prompt[0]!.text })
          return { childId: fake.childId as never, messageId: 'm1' as never }
        },
        followup: async (_parent: unknown, childId: unknown, content: Array<{ text: string }>, _options: unknown) => {
          if (fake.failFollowup !== undefined) throw fake.failFollowup
          fake.followed.push({ childId: String(childId), text: content[0]!.text })
          return 'm2' as never
        },
        interrupt: (targetSessionId: unknown) => {
          fake.interrupts.push(String(targetSessionId))
        },
      } as unknown as SubagentRuntime
    },
  }
  return fake
}

const context: StepContext = { workflowId: 'wf-1', workspaceRoot: '.', stepOutputs: { prev: { child_id: 'c-0' } } }
const parent = { id: 'parent-1' } as unknown as Agent

// ------------------------------------------------------------- EpochWaiter

describe('EpochWaiter', () => {
  it('resolves awaitFirstEnd with the first end of the matching child', async () => {
    const bus = mockEventBus()
    const waiter = new EpochWaiter(bus.ctx)
    const pending = waiter.awaitFirstEnd('child-1', undefined, undefined, realTimer())
    bus.emit('subagent/end', endInfo('child-2', 'r-other', 'completed', 'wrong child'))
    bus.emit('subagent/end', endInfo('child-1', 'r1', 'completed', 'hello'))
    await expect(pending).resolves.toEqual({ stopReason: 'completed', output: [{ type: 'text', text: 'hello' }] })
    waiter.dispose()
  })

  it('pairs resume epochs by runId, ignoring stale ends and other children', async () => {
    const bus = mockEventBus()
    const waiter = new EpochWaiter(bus.ctx)
    const pending = waiter.awaitNextEpoch('child-1', undefined, undefined, realTimer())
    bus.emit('subagent/end', endInfo('child-1', 'r-stale', 'completed', 'stale epoch'))
    bus.emit('subagent/start', startInfo('child-2', 'r-other'))
    bus.emit('subagent/end', endInfo('child-2', 'r-other', 'completed', 'other child'))
    bus.emit('subagent/start', startInfo('child-1', 'r2'))
    bus.emit('subagent/end', endInfo('child-1', 'r2', 'max-tokens', 'partial'))
    await expect(pending).resolves.toEqual({ stopReason: 'max-tokens', output: [{ type: 'text', text: 'partial' }] })
    waiter.dispose()
  })

  it('rejects on timeout when no epoch settles', async () => {
    const bus = mockEventBus()
    const waiter = new EpochWaiter(bus.ctx)
    const pending = waiter.awaitFirstEnd('child-1', 20, undefined, realTimer())
    await expect(pending).rejects.toThrow(/timed out after 20 ms/)
    waiter.dispose()
  })

  it('rejects with CancelledError when the signal fires', async () => {
    const bus = mockEventBus()
    const waiter = new EpochWaiter(bus.ctx)
    const controller = new AbortController()
    const pending = waiter.awaitFirstEnd('child-1', undefined, controller.signal, realTimer())
    controller.abort()
    await expect(pending).rejects.toThrow('agent step cancelled')
    waiter.dispose()
  })
})

// --------------------------------------------------------- DshAgentExecutor

describe('DshAgentExecutor', () => {
  it('delegate starts a continuable child, records its id, and settles on its first end', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const params: AgentDelegateStepParams = { prompt: 'work on {prev.child_id}' }
    const pending = executor.delegate(params, context)
    await tick()
    bus.emit('subagent/end', endInfo('child-1', 'r1', 'completed', 'all done'))
    const result = await pending
    expect(fake.started).toEqual([{ provider: 'spawn', label: 'gatedflow:wf-1', prompt: 'work on c-0' }])
    expect(result.completed).toBe(true)
    expect(result.output).toMatchObject({ child_id: 'child-1', text: 'all done', stop_reason: 'completed' })
  })

  it('delegate reports a non-completed stop reason without failing the engine', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const pending = executor.delegate({ prompt: 'x' }, context)
    await tick()
    bus.emit('subagent/end', endInfo('child-1', 'r1', 'refusal'))
    const result = await pending
    expect(result.completed).toBe(false)
    expect(result.error).toContain('declined')
    expect(result.output).toMatchObject({ child_id: 'child-1', stop_reason: 'refusal' })
  })

  it('delegate interrupts the child and reports aborted when cancelled mid-turn', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    const controller = new AbortController()
    executor.bind(parent, controller.signal)
    const pending = executor.delegate({ prompt: 'long job' }, context)
    await tick()
    controller.abort()
    const result = await pending
    expect(result.completed).toBe(false)
    expect(result.aborted).toBe(true)
    expect(fake.interrupts).toEqual(['child-1'])
  })

  it('delegate fails loud when the provider is missing', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    fake.providerExists = false
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const result = await executor.delegate({ prompt: 'x' }, context)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('not registered')
    expect(fake.started).toEqual([])
  })

  it('delegate fails without a calling agent', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(undefined, undefined)
    const result = await executor.delegate({ prompt: 'x' }, context)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('no calling agent')
  })

  it('resume follows up the recorded child and settles on the paired next epoch', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const params: AgentResumeStepParams = { session: '{prev.child_id}', feedback: 'try again' }
    const pending = executor.resume(params, context)
    await tick()
    expect(fake.followed).toEqual([{ childId: 'c-0', text: 'try again' }])
    bus.emit('subagent/start', startInfo('c-0', 'r2'))
    bus.emit('subagent/end', endInfo('c-0', 'r2', 'completed', 'fixed'))
    const result = await pending
    expect(result.completed).toBe(true)
    expect(result.output).toMatchObject({ session: 'c-0', text: 'fixed' })
  })

  it('resume reports the followup failure and never waits on events', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    fake.failFollowup = new Error('child gone')
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const result = await executor.resume({ session: 'c-0', feedback: 'x' }, context)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('child gone')
  })

  it('resume requires a non-empty session', async () => {
    const bus = mockEventBus()
    const fake = fakeSubagents()
    const ctx = Object.assign(bus.ctx, { subagents: fake.runtime() })
    const executor = new DshAgentExecutor({ ctx, provider: 'spawn', timer: realTimer() })
    executor.bind(parent, undefined)
    const result = await executor.resume({ session: '', feedback: 'x' }, context)
    expect(result.completed).toBe(false)
    expect(result.error).toContain('missing session')
    expect(fake.followed).toEqual([])
  })
})
