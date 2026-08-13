import { describe, expect, it } from 'vitest'
import { expandDynamic, effectiveParams, planText, sanitize } from '../src/expand.js'
import { InvalidAtomicsError, MissingParamError, UnknownSubflowError } from '../src/errors.js'
import type { SubflowDef, SubflowRegistry } from '../src/types.js'

function registry(flows: SubflowDef[]): SubflowRegistry {
  const map = new Map(flows.map((flow) => [flow.name, flow]))
  return { get: (name) => map.get(name), names: () => [...map.keys()] }
}

const demoA: SubflowDef = {
  name: 'demo-a',
  steps: [{ id: 'one', type: 'shell', params: { command: 'echo ${x}' }, on_success: 'next', on_failure: 'abort' }],
  params: { x: { required: true } },
}

const demoB: SubflowDef = {
  name: 'demo-b',
  steps: [{ id: 'two', type: 'shell', params: { command: 'echo b', expect: 'true' }, on_success: 'next', on_failure: 'abort' }],
}

describe('sanitize', () => {
  it('replaces non-identifier characters', () => {
    expect(sanitize('develop-to-push')).toBe('develop_to_push')
    expect(sanitize('a b/c')).toBe('a_b_c')
  })
})

describe('effectiveParams', () => {
  it('applies provided values, defaults, and detects missing required params', () => {
    const flow: SubflowDef = {
      name: 'p',
      params: { a: { required: true }, b: { default: 'dft' } },
      steps: [],
    }
    expect(effectiveParams(flow, { a: 'v' })).toEqual({ a: 'v', b: 'dft' })
    expect(() => effectiveParams(flow, {})).toThrow(MissingParamError)
  })
})

describe('expandDynamic', () => {
  const reg = registry([demoA, demoB])

  it('path ① single Ref: no pre_start_gate', () => {
    const expanded = expandDynamic([{ name: 'demo-a', params: { x: 'hello' } }], reg)
    expect(expanded.wrapped).toBe(false)
    expect(expanded.entry).toBe('demo_a_one')
    expect(expanded.steps['demo_a_one']!.params.command).toBe('echo hello')
    // 'next' from the only block wires to done.
    expect(expanded.steps['demo_a_one']!.on_success).toBe('done')
  })

  it('path ② multiple Refs: pre_start_gate wraps before any work', () => {
    const expanded = expandDynamic([{ name: 'demo-a', params: { x: 'hi' } }, { name: 'demo-b', params: {} }], reg)
    expect(expanded.wrapped).toBe(true)
    expect(expanded.entry).toBe('pre_start_gate')
    const gate = expanded.steps['pre_start_gate']!
    expect(gate.type).toBe('interrupt')
    expect(gate.on_approve).toBe('demo_a_one')
    expect(gate.on_reject).toBe('abort')
    // Block wiring: a → b entry → done.
    expect(expanded.steps['demo_a_one']!.on_success).toBe('demo_b_two')
    expect(expanded.steps['demo_b_two']!.on_success).toBe('done')
  })

  it('duplicate Ref names get distinct prefixes without id collision', () => {
    const expanded = expandDynamic([{ name: 'demo-a', params: { x: '1' } }, { name: 'demo-a', params: { x: '2' } }], reg)
    const ids = expanded.stepOrder.filter((id) => id !== 'pre_start_gate' && id !== 'done')
    expect(ids).toEqual(['demo_a_one', 'demo_a_2_one'])
    expect(expanded.steps['demo_a_one']!.params.command).toBe('echo 1')
    expect(expanded.steps['demo_a_2_one']!.params.command).toBe('echo 2')
    expect(expanded.steps['demo_a_one']!.on_success).toBe('demo_a_2_one')
  })

  it('inline steps get unique ids and default routing', () => {
    const expanded = expandDynamic([{ name: 'demo-a', params: { x: 'z' } }, { type: 'shell', params: { command: 'echo inline' } }], reg)
    const inlineId = expanded.stepOrder.find((id) => id.startsWith('inline'))
    expect(inlineId).toBe('inline1_inline_shell_1')
    expect(expanded.steps[inlineId!]!.on_success).toBe('done')
  })

  it('rewrites cross-subflow export references', () => {
    const dev: SubflowDef = {
      name: 'dev',
      exports: { session_name: { from: 'code.sn' } },
      steps: [{ id: 'code', type: 'shell', params: { command: 'x' }, on_success: 'next', on_failure: 'abort' }],
    }
    const mr: SubflowDef = {
      name: 'mr',
      steps: [{ id: 'gcmr', type: 'shell', params: { command: 'wxa gcmr --session {dev.session_name} && echo ${branch}' }, on_success: 'next', on_failure: 'abort' }],
      params: { branch: { default: 'release' } },
    }
    const expanded = expandDynamic([{ name: 'dev', params: {} }, { name: 'mr', params: {} }], registry([dev, mr]))
    expect(expanded.steps['mr_gcmr']!.params.command).toBe('wxa gcmr --session {dev_code.sn} && echo release')
  })

  it('rewrites local step references with the block prefix', () => {
    const flow: SubflowDef = {
      name: 'f',
      steps: [
        { id: 'gather', type: 'handoff', params: { task_hint: 'do it' }, on_success: 'judge', on_failure: 'abort' },
        { id: 'judge', type: 'conditional', params: { expr: '{gather.result.found} == true' }, on_true: 'next', on_false: 'abort' },
      ],
    }
    const expanded = expandDynamic([{ name: 'f', params: {} }], registry([flow]))
    expect(expanded.steps['f_judge']!.params.expr).toBe('{f_gather.result.found} == true')
  })

  it('rejects unknown subflows and bad atomics', () => {
    expect(() => expandDynamic([{ name: 'ghost', params: {} }], reg)).toThrow(UnknownSubflowError)
    expect(() => expandDynamic([], reg)).toThrow(InvalidAtomicsError)
    expect(() => expandDynamic([{ type: 'nope' } as never], reg)).toThrow(InvalidAtomicsError)
  })

  it('planText lists steps with commands and expects', () => {
    const expanded = expandDynamic([{ name: 'demo-a', params: { x: 'y' } }, { name: 'demo-b', params: {} }], reg)
    const plan = planText(expanded.stepOrder.filter((id) => id !== 'done').map((id) => expanded.steps[id]!))
    expect(plan).toContain('demo_a_one')
    expect(plan).toContain('command=echo y')
    expect(plan).toContain('expect=true')
  })
})
