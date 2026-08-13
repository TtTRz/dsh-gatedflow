import { describe, expect, it } from 'vitest'
import { DecisionMismatchError, GatedflowError } from '../src/errors.js'
import {
  WorkflowRuntime,
  type AuditRecord,
  type AuditSink,
  type EngineServices,
  type ShellRequest,
  type ShellRunResult,
  type SubflowRegistry,
  type WorkflowSnapshot,
} from '../src/index.js'
import type { SubflowDef } from '../src/types.js'
import type { WorkflowRuntimeState } from '../src/index.js'

// ------------------------------------------------------------------ fakes

class MemoryStore {
  saved: WorkflowRuntimeState[] = []

  async save(state: WorkflowRuntimeState): Promise<void> {
    this.saved.push(JSON.parse(JSON.stringify(state)) as WorkflowRuntimeState)
  }
}

class ScriptedShell {
  private queue: ShellRunResult[] = []
  requests: ShellRequest[] = []

  constructor(private readonly fallback: ShellRunResult = success('', 'ok')) {}

  enqueue(result: ShellRunResult): void {
    this.queue.push(result)
  }

  async run(request: ShellRequest): Promise<ShellRunResult> {
    this.requests.push(request)
    return this.queue.shift() ?? this.fallback
  }
}

class FakeTimer {
  pending: { ms: number; callback: () => void }[] = []

  set(ms: number, callback: () => void): () => void {
    const entry = { ms, callback }
    this.pending.push(entry)
    return () => {
      this.pending = this.pending.filter((item) => item !== entry)
    }
  }

  fireAll(): void {
    for (const entry of this.pending.splice(0)) entry.callback()
  }
}

function success(stdout = '', stderr = ''): ShellRunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false, aborted: false, stdoutSpill: null, stderrSpill: null }
}

function failure(exitCode = 1, stderr = 'boom'): ShellRunResult {
  return { exitCode, stdout: '', stderr, timedOut: false, aborted: false, stdoutSpill: null, stderrSpill: null }
}

function aborted(): ShellRunResult {
  return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, stdoutSpill: null, stderrSpill: null }
}

function registry(flows: SubflowDef[]): SubflowRegistry {
  const map = new Map(flows.map((flow) => [flow.name, flow]))
  return { get: (name) => map.get(name), names: () => [...map.keys()] }
}

function services(overrides: Partial<EngineServices> & { shell: ScriptedShell }): EngineServices & { audits: AuditRecord[] } {
  const audits: AuditRecord[] = []
  const sink: AuditSink = (_workflowId, record) => {
    audits.push(record)
  }
  return {
    registry: registry([]),
    shell: overrides.shell,
    store: overrides.store ?? new MemoryStore(),
    timer: overrides.timer ?? new FakeTimer(),
    audit: sink,
    ...overrides,
    audits,
  }
}

const HANDOFF_FLOW: SubflowDef = {
  name: 'research',
  steps: [
    { id: 'gather', type: 'handoff', params: { task_hint: 'research ${question}' }, on_success: 'judge', on_failure: 'abort' },
    { id: 'judge', type: 'conditional', params: { expr: '{gather.result.found} == true' }, on_true: 'report', on_false: 'abort' },
    { id: 'report', type: 'shell', params: { command: 'echo "ANSWER: {gather.result.answer}"', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
  ],
  params: { question: { required: true } },
}

const GATED_FLOW: SubflowDef = {
  name: 'gated',
  steps: [
    { id: 'review', type: 'interrupt', params: { message: 'Confirm to publish?' }, on_approve: 'ship', on_reject: 'abort' },
    { id: 'ship', type: 'shell', params: { command: 'echo SHIPPED', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
  ],
}

const RETRY_FLOW: SubflowDef = {
  name: 'retry-flow',
  steps: [
    { id: 'probe', type: 'shell', params: { command: 'check', max_retries: 1, pause_on_failure: true }, on_success: 'finish', on_failure: 'abort' },
    { id: 'finish', type: 'shell', params: { command: 'echo DONE', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
  ],
}

// ---------------------------------------------------------------- handoff

describe('WorkflowRuntime: handoff', () => {
  it('pauses on handoff, continues with structured result, completes', async () => {
    const shell = new ScriptedShell()
    // report step: command run, then expect run.
    shell.enqueue(success('ANSWER: the answer\n'))
    const env = services({ shell, registry: registry([HANDOFF_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'research', params: { question: 'Q' } }] })

    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().gate?.checkpoint_type).toBe('handoff')
    expect(runtime.snapshot().gate?.task_hint).toBe('research Q')

    const snap = await runtime.advance('handoff_complete', { found: true, answer: 'the answer' })
    expect(snap.status).toBe('completed')
    expect(snap.completed_steps).toEqual(['research_gather', 'research_judge', 'research_report'])

    const outputs = runtime.outputs()
    expect(outputs['research_report']).toMatchObject({ exit_code: 0 })
    expect(outputs['research_report']?.stdout).toBe('ANSWER: the answer\n')

    const events = env.audits.map((a) => a.event)
    expect(events).toContain('handoff')
    expect(events[events.length - 1]).toBe('completed')
    // Persistence happened on every transition; final snapshot is terminal.
    expect((env.store as MemoryStore).saved.at(-1)?.status).toBe('completed')
  })

  it('rejects mismatched decisions on a handoff gate', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([HANDOFF_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'research', params: { question: 'Q' } }] })
    await expect(runtime.advance('retry')).rejects.toThrow(DecisionMismatchError)
  })
})

// ------------------------------------------------------------------- gates

describe('WorkflowRuntime: interrupt gates', () => {
  it('approve routes on_approve and completes', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })

    expect(runtime.snapshot().gate?.checkpoint_type).toBe('user_confirm')
    const snap = await runtime.decide('approve', undefined, 'panel')
    expect(snap.status).toBe('completed')
    expect(runtime.outputs()['gated_review']).toMatchObject({ decision: 'approve', source: 'panel' })
    const decisions = env.audits.filter((a) => a.event === 'gate_decision')
    expect(decisions[0]?.data).toMatchObject({ decision: 'approve', source: 'panel' })
  })

  it('reject routes on_reject (abort) and fails', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })
    const snap = await runtime.decide('reject', 'not now')
    expect(snap.status).toBe('failed')
    expect(snap.error).toContain('abort')
  })

  it('rejects double decisions and decisions outside a gate', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })
    await runtime.decide('approve')
    await expect(runtime.decide('approve')).rejects.toThrow(DecisionMismatchError)
  })
})

// ------------------------------------------------------- deadline timeout

describe('WorkflowRuntime: gate deadline', () => {
  it('auto-fails a paused gate when the deadline fires', async () => {
    const timer = new FakeTimer()
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]), timer })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })
    expect(runtime.getStatus()).toBe('paused')
    expect(timer.pending).toHaveLength(1)
    expect(timer.pending[0]?.ms).toBe(1800 * 1000)

    timer.fireAll()
    expect(runtime.getStatus()).toBe('failed')
    expect(runtime.snapshot().error).toContain('gate deadline exceeded')
    expect(env.audits.some((a) => a.event === 'gate_timeout')).toBe(true)
  })

  it('honours per-step deadline_secs and clears the timer on decision', async () => {
    const shortGate: SubflowDef = {
      name: 'short',
      steps: [
        { id: 'gate', type: 'interrupt', params: { message: 'q', deadline_secs: 2 }, on_approve: 'next', on_reject: 'abort' },
      ],
    }
    const timer = new FakeTimer()
    const env = services({ shell: new ScriptedShell(), registry: registry([shortGate]), timer })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'short', params: {} }] })
    expect(timer.pending[0]?.ms).toBe(2000)
    await runtime.decide('approve')
    // Decision cleared the deadline; firing leftover timers is a no-op.
    timer.fireAll()
    expect(runtime.getStatus()).toBe('completed')
  })
})

// ------------------------------------------------------------------ retry

describe('WorkflowRuntime: zero-mutation retry', () => {
  it('pauses on failure with pause_on_failure, retries after repair, keeps prior outputs', async () => {
    const shell = new ScriptedShell()
    shell.enqueue(failure(1, 'probe missing'))
    shell.enqueue(failure(1, 'probe missing')) // max_retries=1: second attempt also fails
    shell.enqueue(success('probe now', '')) // retry run
    const env = services({ shell, registry: registry([RETRY_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'retry-flow', params: {} }] })

    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().pending).toBe('retry')

    const snap = await runtime.advance('retry')
    expect(snap.status).toBe('completed')
    expect(snap.retry_counts).toEqual({ retry_flow_probe: 1 })
    expect(env.audits.some((a) => a.event === 'step_failed_pause')).toBe(true)
    expect(env.audits.some((a) => a.event === 'retry')).toBe(true)
  })

  it('rejects non-retry decisions while pending retry', async () => {
    const shell = new ScriptedShell()
    shell.enqueue(failure(1))
    shell.enqueue(failure(1))
    const env = services({ shell, registry: registry([RETRY_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'retry-flow', params: {} }] })
    await expect(runtime.advance('handoff_complete')).rejects.toThrow(DecisionMismatchError)
  })
})

// ------------------------------------------------------- stop/interruption

describe('WorkflowRuntime: interruption semantics', () => {
  it('an aborted shell step pauses (never fails) and resumes in place', async () => {
    const shell = new ScriptedShell()
    shell.enqueue(aborted())
    const flow: SubflowDef = {
      name: 'long',
      steps: [
        { id: 'wait', type: 'shell', params: { command: 'loop' }, on_success: 'finish', on_failure: 'abort' },
        { id: 'finish', type: 'shell', params: { command: 'echo DONE', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
      ],
    }
    const env = services({ shell, registry: registry([flow]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'long', params: {} }] })

    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().error).toBeNull()
    expect(runtime.snapshot().note).toContain('interrupted')
    expect(env.audits.some((a) => a.event === 'interrupted')).toBe(true)

    // Human fixes the environment; resume without a decision re-runs the step.
    const snap = await runtime.advance()
    expect(snap.status).toBe('completed')
    expect(snap.completed_steps).toEqual(['long_wait', 'long_finish'])
    expect(env.audits.some((a) => a.event === 'resume')).toBe(true)
  })
})

describe('WorkflowRuntime: restore', () => {
  it('rebuilds a paused runtime from a persisted state record', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([HANDOFF_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'research', params: { question: 'Q' } }] })
    const state = (env.store as MemoryStore).saved.at(-1)!
    expect(state.status).toBe('paused')

    const restored = WorkflowRuntime.restore(env, state)
    expect(restored.snapshot().workflow_id).toBe(state.workflow_id)
    expect(restored.getStatus()).toBe('paused')
    expect(restored.snapshot().gate?.checkpoint_type).toBe('handoff')

    // The restored runtime continues normally.
    env.shell.enqueue(success('ANSWER: restored\n'))
    const snap = await restored.advance('handoff_complete', { found: true, answer: 'restored' })
    expect(snap.status).toBe('completed')
  })

  it('restores orphaned running state as paused', () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([HANDOFF_FLOW]) })
    const runtime = WorkflowRuntime.restore(env, {
      workflow_id: 'wf-x',
      status: 'running',
      current_step: 'pre_start_gate',
      completed_steps: [],
      step_outputs: {},
      retry_counts: {},
      pending: null,
      gate: null,
      error: null,
      note: null,
      workspace_root: '.',
      created_at: 1,
      updated_at: 2,
      steps: { pre_start_gate: { id: 'pre_start_gate', type: 'interrupt', params: { message: 'm' }, on_approve: 'done', on_reject: 'abort' }, done: { id: 'done', type: 'done', params: {} } },
      step_order: ['pre_start_gate', 'done'],
      wrapped: true,
    })
    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().note).toContain('reconciled')
  })
})

// ----------------------------------------------------------- misc/guards

describe('WorkflowRuntime: guards and errors', () => {
  it('agent steps fail loudly without an agent executor', async () => {
    const flow: SubflowDef = {
      name: 'delegated',
      steps: [{ id: 'd', type: 'agent_delegate', params: { prompt: 'do it' }, on_success: 'next', on_failure: 'abort' }],
    }
    const env = services({ shell: new ScriptedShell(), registry: registry([flow]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'delegated', params: {} }] })
    expect(runtime.getStatus()).toBe('failed')
    expect(runtime.snapshot().error).toContain('no agent executor')
  })

  it('an aborted agent_delegate pauses instead of failing (D6)', async () => {
    const flow: SubflowDef = {
      name: 'delegated',
      steps: [{ id: 'd', type: 'agent_delegate', params: { prompt: 'do it' }, on_success: 'next', on_failure: 'abort' }],
    }
    const agent = {
      delegate: async () => ({ completed: false, aborted: true, output: { partial: true }, error: 'cancelled' }),
      resume: async () => ({ completed: false, aborted: true, output: null, error: 'cancelled' }),
    }
    const env = services({ shell: new ScriptedShell(), registry: registry([flow]), agent })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'delegated', params: {} }] })
    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().error).toBeNull()
    expect(runtime.snapshot().step_outputs.delegated_d).toEqual({ partial: true })
    expect(runtime.snapshot().note).toContain('interrupted at delegated_d')
    // Resuming without a decision re-runs the step in place.
    agent.delegate = async () => ({ completed: true, output: { done: true } })
    const after = await runtime.advance()
    expect(after.status).toBe('completed')
    expect(after.step_outputs.delegated_d).toEqual({ done: true })
  })

  it('an aborted agent_resume pauses instead of failing (D6)', async () => {
    const flow: SubflowDef = {
      name: 'resumed',
      steps: [
        { id: 'd', type: 'agent_delegate', params: { prompt: 'seed' }, on_success: 'r', on_failure: 'abort' },
        { id: 'r', type: 'agent_resume', params: { session: '{d.child_id}', feedback: 'fix it' }, on_success: 'next' },
      ],
    }
    const agent = {
      delegate: async () => ({ completed: true, output: { child_id: 'c1' } }),
      resume: async () => ({ completed: false, aborted: true, output: null, error: 'cancelled' }),
    }
    const env = services({ shell: new ScriptedShell(), registry: registry([flow]), agent })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'resumed', params: {} }] })
    expect(runtime.getStatus()).toBe('paused')
    expect(runtime.snapshot().error).toBeNull()
    expect(runtime.snapshot().current_step).toBe('resumed_r')
  })

  it('advance on a gate throws the panel instruction error', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })
    await expect(runtime.advance()).rejects.toThrow(/decided by the human/)
  })

  it('kill terminates and records the reason', async () => {
    const env = services({ shell: new ScriptedShell(), registry: registry([GATED_FLOW]) })
    const runtime = await WorkflowRuntime.start(env, { atomics: [{ name: 'gated', params: {} }] })
    const snap = await runtime.kill('operator asked')
    expect(snap.status).toBe('failed')
    expect(snap.error).toContain('operator asked')
  })

  it('invalid subflow definitions are rejected at start', async () => {
    const bad: SubflowDef = {
      name: 'bad',
      steps: [{ id: 'a', type: 'shell', params: { command: 'x' }, on_success: 'ghost', on_failure: 'abort' }],
    }
    const env = services({ shell: new ScriptedShell(), registry: registry([bad]) })
    await expect(WorkflowRuntime.start(env, { atomics: [{ name: 'bad', params: {} }] })).rejects.toThrow(GatedflowError)
  })
})
