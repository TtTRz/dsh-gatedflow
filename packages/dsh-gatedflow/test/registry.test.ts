import { describe, expect, it } from 'vitest'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubflowDef } from '@gatedflow/engine'
import { DslRegistry } from '../src/registry.js'

/** In-memory FileSystem double: one flat map keyed by path. */
function fakeFs(entries: Record<string, string> = {}) {
  const files = new Map(Object.entries(entries))
  const fs = {
    async resolve(target: string) {
      return { path: target }
    },
    async readText(ref: { path: string }) {
      const value = files.get(ref.path)
      if (value === undefined) throw new Error(`ENOENT: ${ref.path}`)
      return value
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
  }
  return fs as unknown as FileSystem
}

/** The DSH tools layer rejects any `undefined` value in a tool output. */
function assertNoUndefined(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`undefined value at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      assertNoUndefined((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
  }
}

const MINIMAL: SubflowDef = {
  name: 'minimal',
  description: 'No params, no exports, no keywords.',
  steps: [
    { id: 'run', type: 'shell', params: { command: 'echo hi', expect: 'true' }, on_success: 'done', on_failure: 'abort' },
  ],
}

describe('DslRegistry.summaries', () => {
  it('defaults missing params/exports/keywords to empty JSON-safe values (builtins)', () => {
    const registry = new DslRegistry(fakeFs(), ['/subflows'])
    registry.registerBuiltin(MINIMAL)
    const rows = registry.summaries()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      name: 'minimal',
      description: 'No params, no exports, no keywords.',
      keywords: [],
      params: {},
      exports: {},
    })
    assertNoUndefined(rows, 'rows')
    // Lossless JSON round-trip: nothing the harness snapshotter would reject.
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows)
  })

  it('defaults missing params/exports for file-loaded subflows', async () => {
    const registry = new DslRegistry(
      fakeFs({ '/subflows/minimal.json': JSON.stringify(MINIMAL) }),
      ['/subflows'],
    )
    await registry.reload()
    const rows = registry.summaries()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.params).toEqual({})
    expect(rows[0]!.exports).toEqual({})
    assertNoUndefined(rows, 'rows')
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows)
  })

  it('preserves params and exports when the subflow declares them', () => {
    const registry = new DslRegistry(fakeFs(), ['/subflows'])
    registry.registerBuiltin({
      ...MINIMAL,
      name: 'with-params',
      params: { note: { required: false, description: 'extra note' } },
      exports: { out: { from: 'run.stdout' } },
    } as SubflowDef)
    const rows = registry.summaries()
    expect(rows[0]!.params).toEqual({ note: { required: false, description: 'extra note' } })
    expect(rows[0]!.exports).toEqual({ out: { from: 'run.stdout' } })
    assertNoUndefined(rows, 'rows')
  })
})

describe('DslRegistry.reload', () => {
  it('scans extra dirs after shared dirs, so the workspace overrides shared names', async () => {
    const sharedDef: SubflowDef = { ...MINIMAL, name: 'dup', description: 'shared' }
    const workspaceDef: SubflowDef = { ...MINIMAL, name: 'dup', description: 'workspace' }
    const registry = new DslRegistry(
      fakeFs({
        '/shared/dup.json': JSON.stringify(sharedDef),
        '/ws/dup.json': JSON.stringify(workspaceDef),
      }),
      ['/shared'],
    )
    await registry.reload(['/ws'])
    expect(registry.get('dup')!.description).toBe('workspace')
    expect(registry.names()).toContain('dup')
  })

  it('skips invalid files loudly without dropping valid ones', async () => {
    const registry = new DslRegistry(
      fakeFs({
        '/shared/ok.json': JSON.stringify(MINIMAL),
        '/ws/broken.json': JSON.stringify({ name: 'broken' }),
        '/ws/also-ok.json': JSON.stringify({ ...MINIMAL, name: 'also-ok' }),
      }),
      ['/shared'],
    )
    await registry.reload(['/ws'])
    expect(registry.names()).toEqual(['minimal', 'also-ok'])
  })
})
