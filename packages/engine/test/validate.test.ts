import { describe, expect, it } from 'vitest'
import { assertValidSubflow, validateSubflow } from '../src/validate.js'
import { InvalidSubflowError } from '../src/errors.js'
import type { SubflowDef } from '../src/types.js'

function def(partial: Partial<SubflowDef>): SubflowDef {
  return {
    name: 'test-flow',
    steps: [
      { id: 'a', type: 'shell', params: { command: 'echo hi' }, on_success: 'next', on_failure: 'abort' },
    ],
    ...partial,
  }
}

describe('validateSubflow', () => {
  it('accepts a well-formed subflow', () => {
    expect(validateSubflow(def({}))).toEqual([])
  })

  it('rejects non-objects', () => {
    expect(validateSubflow(null)).toEqual(['subflow must be an object'])
    expect(validateSubflow('nope')).toEqual(['subflow must be an object'])
  })

  it('rejects missing name', () => {
    expect(validateSubflow({ steps: [] })).toContain('missing name')
  })

  it('rejects empty steps', () => {
    expect(validateSubflow({ name: 'x', steps: [] })).toEqual(['steps must be a non-empty array'])
  })

  it('rejects unknown step types', () => {
    const problems = validateSubflow(def({ steps: [{ id: 'a', type: 'nope', params: {} }] as never }))
    expect(problems.some((p) => p.includes('unknown step type'))).toBe(true)
  })

  it('rejects duplicate step ids', () => {
    const problems = validateSubflow(
      def({
        steps: [
          { id: 'a', type: 'shell', params: { command: 'x' }, on_success: 'next', on_failure: 'abort' },
          { id: 'a', type: 'shell', params: { command: 'y' }, on_success: 'next', on_failure: 'abort' },
        ],
      }),
    )
    expect(problems.some((p) => p.includes('duplicate step id'))).toBe(true)
  })

  it('rejects shell steps without params.command', () => {
    const problems = validateSubflow(def({ steps: [{ id: 'a', type: 'shell', params: {}, on_success: 'next', on_failure: 'abort' }] }))
    expect(problems.some((p) => p.includes('requires params.command'))).toBe(true)
  })

  it('rejects conditional steps without params.expr', () => {
    const problems = validateSubflow(
      def({ steps: [{ id: 'a', type: 'conditional', params: {}, on_true: 'next', on_false: 'abort' }] }),
    )
    expect(problems.some((p) => p.includes('requires params.expr'))).toBe(true)
  })

  it('rejects missing routes', () => {
    const problems = validateSubflow(def({ steps: [{ id: 'a', type: 'shell', params: { command: 'x' }, on_failure: 'abort' }] } as never))
    expect(problems.some((p) => p.includes('missing route "on_success"'))).toBe(true)
  })

  it('rejects routes to unknown steps', () => {
    const problems = validateSubflow(def({ steps: [{ id: 'a', type: 'shell', params: { command: 'x' }, on_success: 'ghost', on_failure: 'abort' }] }))
    expect(problems.some((p) => p.includes('targets unknown step "ghost"'))).toBe(true)
  })

  it('accepts engine route words (next/done/abort)', () => {
    const problems = validateSubflow(
      def({ steps: [{ id: 'a', type: 'shell', params: { command: 'x' }, on_success: 'done', on_failure: 'abort' }] }),
    )
    expect(problems).toEqual([])
  })

  it('assertValidSubflow throws InvalidSubflowError with all problems', () => {
    expect(() => assertValidSubflow(def({ steps: [{ id: 'a', type: 'shell', params: {}, on_success: 'next', on_failure: 'abort' }] }))).toThrow(InvalidSubflowError)
  })
})
