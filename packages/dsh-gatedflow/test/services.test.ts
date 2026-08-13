import { describe, expect, it } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkflowRuntimeState } from '@gatedflow/engine'
import { BoundedTailAuditSink, FsWorkflowStore } from '../src/services.js'

/** In-memory FileSystem double: one flat map keyed by path. */
function fakeFs() {
  const files = new Map<string, string>()
  const fs = {
    async resolve(target: string) {
      return { path: target }
    },
    async readText(ref: { path: string }) {
      const value = files.get(ref.path)
      if (value === undefined) throw new Error(`ENOENT: ${ref.path}`)
      return value
    },
    async writeText(ref: { path: string }, text: string) {
      files.set(ref.path, text)
    },
    async listDir(ref: { path: string }) {
      const prefix = ref.path.replace(/\/+$/, '') + '/'
      const names: string[] = []
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        if (rest.includes('/')) continue
        names.push(rest)
      }
      return names.map((name) => ({ name }))
    },
    files,
  }
  return fs as unknown as FileSystem & { files: Map<string, string> }
}

function stateFixture(workflowId: string): WorkflowRuntimeState {
  return {
    workflow_id: workflowId,
    status: 'completed',
    current_step: 'done',
    completed_steps: ['prep'],
    step_outputs: {},
    retry_counts: {},
    pending: null,
    gate: null,
    error: null,
    note: null,
    workspace_root: '/ws',
    created_at: 1,
    updated_at: 2,
    steps: {
      prep: { id: 'prep', type: 'shell', params: { command: 'true', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
      done: { id: 'done', type: 'done', params: {} },
    },
    step_order: ['prep', 'done'],
    wrapped: false,
  }
}

describe('FsWorkflowStore', () => {
  it('saves, loads, and lists workflow states', async () => {
    const fs = fakeFs()
    const store = new FsWorkflowStore(fs, '/ws/.gatedflow/workflows')
    await store.save(stateFixture('wf-1'))
    await store.save(stateFixture('wf-2'))
    expect(await store.listIds()).toEqual(['wf-1', 'wf-2'])
    const loaded = await store.load('wf-1')
    expect(loaded?.workflow_id).toBe('wf-1')
    expect(loaded?.status).toBe('completed')
  })

  it('returns null for missing or corrupt records', async () => {
    const fs = fakeFs()
    const store = new FsWorkflowStore(fs, '/ws/.gatedflow/workflows')
    expect(await store.load('absent')).toBeNull()
    await fs.writeText(await fs.resolve('/ws/.gatedflow/workflows/broken.json'), '{not json')
    expect(await store.load('broken')).toBeNull()
  })

  it('ignores non-json files when listing', async () => {
    const fs = fakeFs()
    const store = new FsWorkflowStore(fs, '/ws/.gatedflow/workflows')
    await store.save(stateFixture('wf-1'))
    await fs.writeText(await fs.resolve('/ws/.gatedflow/workflows/notes.txt'), 'hi')
    expect(await store.listIds()).toEqual(['wf-1'])
  })
})

describe('BoundedTailAuditSink', () => {
  function timerCapture() {
    const pending = new Map<number, () => void>()
    let seq = 0
    const timeout = (callback: () => void, delay: number) => {
      const id = ++seq
      pending.set(id, callback)
      return () => pending.delete(id)
    }
    return { timeout, pending }
  }

  /** One macrotask: drains the async flush chain (resolve/read/write awaits). */
  function drain() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('flushes queued records as JSONL after the debounce timer fires', async () => {
    const fs = fakeFs()
    const timers = timerCapture()
    const sink = new BoundedTailAuditSink(fs, '/ws/.gatedflow/audit', timers.timeout, 700, 500)
    sink.queueFor('wf-1', { ts: 't1', event: 'start', data: {} })
    sink.queueFor('wf-1', { ts: 't2', event: 'step_success', data: { step: 'p' } })
    expect(fs.files.size).toBe(0)
    for (const cb of timers.pending.values()) cb()
    await drain()
    expect(fs.files.get('/ws/.gatedflow/audit/wf-1.jsonl')).toBe(
      '{"ts":"t1","event":"start","data":{}}\n{"ts":"t2","event":"step_success","data":{"step":"p"}}\n',
    )
  })

  it('flushes immediately on terminal events', async () => {
    const fs = fakeFs()
    const timers = timerCapture()
    const sink = new BoundedTailAuditSink(fs, '/ws/.gatedflow/audit', timers.timeout, 700, 500)
    sink.queueFor('wf-1', { ts: 't1', event: 'start', data: {} })
    sink.queueFor('wf-1', { ts: 't2', event: 'completed', data: {} })
    await drain()
    expect(fs.files.get('/ws/.gatedflow/audit/wf-1.jsonl')).toContain('"event":"completed"')
  })

  it('bounds the rewritten file to the tail length', async () => {
    const fs = fakeFs()
    const timers = timerCapture()
    const sink = new BoundedTailAuditSink(fs, '/ws/.gatedflow/audit', timers.timeout, 0, 3)
    for (let i = 0; i < 5; i++) sink.queueFor('wf-1', { ts: `t${i}`, event: 'start', data: { i } })
    for (const cb of timers.pending.values()) cb()
    await drain()
    const lines = fs.files.get('/ws/.gatedflow/audit/wf-1.jsonl')!.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain('"i":4')
  })

  it('merges new records into the existing tail', async () => {
    const fs = fakeFs()
    const timers = timerCapture()
    await fs.writeText(await fs.resolve('/ws/.gatedflow/audit/wf-1.jsonl'), '{"ts":"old","event":"start","data":{}}\n')
    const sink = new BoundedTailAuditSink(fs, '/ws/.gatedflow/audit', timers.timeout, 0, 500)
    sink.queueFor('wf-1', { ts: 'new', event: 'step_success', data: {} })
    for (const cb of timers.pending.values()) cb()
    await drain()
    const lines = fs.files.get('/ws/.gatedflow/audit/wf-1.jsonl')!.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"ts":"old"')
    expect(lines[1]).toContain('"ts":"new"')
  })
})
