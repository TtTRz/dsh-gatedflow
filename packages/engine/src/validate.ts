/**
 * Structural validation of declarative subflows (gatedflow D15, load-time layer).
 *
 * A subflow is data, not code: every definition is checked before it enters
 * the registry so that typos in step types, missing routes, or dangling
 * route targets fail loudly at load/reload time instead of mid-run.
 */

import { InvalidSubflowError } from './errors.js'
import { ROUTE_KEYS, STEP_TYPES } from './types.js'
import type { JsonValue, StepDef, SubflowDef } from './types.js'

const ENGINE_ROUTES = new Set(['next', 'done', 'abort'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function paramString(params: unknown, key: string): string | undefined {
  if (!isRecord(params)) return undefined
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validate one subflow definition and return a list of human-readable
 * problems (empty when valid).
 */
export function validateSubflow(data: unknown): string[] {
  const problems: string[] = []

  if (!isRecord(data)) return ['subflow must be an object']
  const def = data as Partial<SubflowDef>

  if (typeof def.name !== 'string' || def.name.length === 0) {
    problems.push('missing name')
  }
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    return [...problems, 'steps must be a non-empty array']
  }

  const ids = new Set<string>()
  for (const [index, rawStep] of def.steps.entries()) {
    const where = `step[${index}]`
    if (!isRecord(rawStep)) {
      problems.push(`${where}: step must be an object`)
      continue
    }
    const step = rawStep as Partial<StepDef>

    if (typeof step.id !== 'string' || step.id.length === 0) {
      problems.push(`${where}: missing id`)
      continue
    }
    if (ids.has(step.id)) {
      problems.push(`${where}: duplicate step id "${step.id}"`)
      continue
    }
    ids.add(step.id)

    if (typeof step.type !== 'string' || !(STEP_TYPES as readonly string[]).includes(step.type)) {
      problems.push(`${where} (${step.id}): unknown step type "${String(step.type)}"`)
      continue
    }
    const type = step.type as StepDef['type']

    const params = (step as { params?: unknown }).params
    if (type === 'shell' && paramString(params, 'command') === undefined) {
      problems.push(`${where} (${step.id}): shell step requires params.command`)
    }
    if (type === 'conditional' && paramString(params, 'expr') === undefined) {
      problems.push(`${where} (${step.id}): conditional step requires params.expr`)
    }
  }

  // Second pass over well-formed steps: routing completeness and targets.
  for (const [index, rawStep] of def.steps.entries()) {
    if (!isRecord(rawStep)) continue
    const step = rawStep as Partial<StepDef>
    if (typeof step.id !== 'string' || !ids.has(step.id)) continue
    if (typeof step.type !== 'string' || !(STEP_TYPES as readonly string[]).includes(step.type)) continue
    const type = step.type as StepDef['type']

    for (const key of ROUTE_KEYS[type]) {
      const target = (step as unknown as Record<string, JsonValue>)[key]
      if (typeof target !== 'string' || target.length === 0) {
        problems.push(`step[${index}] (${step.id}): missing route "${key}"`)
        continue
      }
      if (!ENGINE_ROUTES.has(target) && !ids.has(target)) {
        problems.push(`step[${index}] (${step.id}): route "${key}" targets unknown step "${target}"`)
      }
    }
  }

  return problems
}

/** Validate and throw {@link InvalidSubflowError} listing every problem. */
export function assertValidSubflow(def: SubflowDef): void {
  const problems = validateSubflow(def)
  if (problems.length > 0) {
    throw new InvalidSubflowError(`subflow ${def.name} is invalid: ${problems.join('; ')}`, { name: def.name, problems })
  }
}
