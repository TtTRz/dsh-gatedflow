import { describe, expect, it } from 'vitest'
import { evalCondition, substituteRuntime } from '../src/condition.js'
import { ConditionParseError } from '../src/errors.js'

const outputs = {
  step: { ready: true, count: 3, name: 'prod', tags: ['a', 'b'] },
}

describe('evalCondition', () => {
  it('supports equality and inequality', () => {
    expect(evalCondition('{step.ready} == true', outputs)).toBe(true)
    expect(evalCondition('{step.ready} != true', outputs)).toBe(false)
    expect(evalCondition('{step.count} == 3', outputs)).toBe(true)
    expect(evalCondition('{step.name} == "prod"', outputs)).toBe(true)
    expect(evalCondition("{step.name} == 'dev'", outputs)).toBe(false)
  })

  it('supports numeric comparisons', () => {
    expect(evalCondition('{step.count} > 2', outputs)).toBe(true)
    expect(evalCondition('{step.count} >= 3', outputs)).toBe(true)
    expect(evalCondition('{step.count} < 3', outputs)).toBe(false)
    expect(evalCondition('{step.count} <= 2', outputs)).toBe(false)
  })

  it('supports contains on strings and arrays', () => {
    expect(evalCondition('{step.name} contains "ro"', outputs)).toBe(true)
    expect(evalCondition('{step.tags} contains "b"', outputs)).toBe(true)
    expect(evalCondition('{step.tags} contains "z"', outputs)).toBe(false)
    expect(evalCondition('null contains "x"', outputs)).toBe(false)
  })

  it('supports && || ! and parentheses', () => {
    expect(evalCondition('{step.ready} == true && {step.count} > 2', outputs)).toBe(true)
    expect(evalCondition('{step.ready} == false || {step.count} > 2', outputs)).toBe(true)
    expect(evalCondition('!({step.count} > 2)', outputs)).toBe(false)
    expect(evalCondition('({step.ready} == true && {step.count} < 1) || {step.count} == 3', outputs)).toBe(true)
  })

  it('supports bare literals', () => {
    expect(evalCondition('true', outputs)).toBe(true)
    expect(evalCondition('false', outputs)).toBe(false)
    expect(evalCondition('!false', outputs)).toBe(true)
  })

  it('treats missing references as undefined', () => {
    expect(evalCondition('{nope.missing} == true', outputs)).toBe(false)
  })

  it('throws ConditionParseError on malformed expressions', () => {
    expect(() => evalCondition('{step.count} ==', outputs)).toThrow(ConditionParseError)
    expect(() => evalCondition('{unclosed', outputs)).toThrow(ConditionParseError)
    expect(() => evalCondition('1 &&', outputs)).toThrow(ConditionParseError)
  })
})

describe('substituteRuntime', () => {
  it('replaces string values and leaves missing refs empty', () => {
    expect(substituteRuntime('name={step.name}', outputs)).toBe('name=prod')
    expect(substituteRuntime('x={nope.missing}y', outputs)).toBe('x=y')
  })

  it('renders structured values as JSON', () => {
    expect(substituteRuntime('tags={step.tags}', outputs)).toBe('tags=["a","b"]')
  })

  it('keeps text without refs unchanged', () => {
    expect(substituteRuntime('plain text $HOME', outputs)).toBe('plain text $HOME')
  })
})
