/**
 * Declarative expansion: `atomics` → flat, prefixed, gate-wrapped step list.
 *
 * One input, two paths (gatedflow's core routing decision):
 *
 * - Path ① — a single `Ref` runs the named preset deterministically;
 *   no `pre_start_gate` is wrapped (there is no ad-hoc plan to review).
 * - Path ② — multiple atomics and/or `Inline` steps compose dynamically;
 *   the engine wraps a `pre_start_gate` that pauses for human approval of
 *   the full plan *before any real work starts*.
 *
 * Expansion snapshots each subflow at start time: later file edits never
 * affect a running workflow, so what the human approves is exactly what
 * executes.
 */

import { InvalidAtomicsError, MissingParamError, UnknownSubflowError } from './errors.js'
import { assertValidSubflow } from './validate.js'
import { ROUTE_KEYS } from './types.js'
import type {
  AtomicSpec,
  ExpandedStep,
  ExpandedWorkflow,
  JsonValue,
  RouteKey,
  RouteValue,
  StepDef,
  SubflowDef,
  SubflowRef,
  SubflowRegistry,
} from './types.js'

/** Normalize an arbitrary name into a safe step-id prefix component. */
export function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_')
}

function scalarToString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function isRef(atomic: AtomicSpec): atomic is SubflowRef {
  const candidate = atomic as SubflowRef
  return typeof candidate.name === 'string' && (candidate as { type?: unknown }).type === undefined
}

/** Resolve effective params: provided value, else spec default, else undefined. */
export function effectiveParams(def: SubflowDef, provided: Record<string, JsonValue> = {}): Record<string, JsonValue | undefined> {
  const spec = def.params ?? {}
  const effective: Record<string, JsonValue | undefined> = {}
  for (const [key, entry] of Object.entries(spec)) {
    effective[key] = provided[key] !== undefined ? provided[key] : (entry.default ?? undefined)
  }
  const missing = Object.entries(spec)
    .filter(([key, entry]) => entry.required && (effective[key] === undefined || effective[key] === null || effective[key] === ''))
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new MissingParamError(def.name, missing)
  }
  return effective
}

type ExportResolver = (subflowName: string, exportName: string) => string | null

/** Build-time substitution: `${param}` values plus `{ref}` prefix rewriting. */
export function substituteParams(
  value: JsonValue | undefined,
  provided: Record<string, JsonValue | undefined>,
  prefix: string,
  localIds: string[],
  resolveExport: ExportResolver,
): JsonValue | undefined {
  if (typeof value === 'string') {
    return value
      .replace(/\$\{(\w+)\}/g, (_match, key: string) => scalarToString(provided[key]))
      .replace(/\{([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\}/g, (match, first: string, rest: string) => {
        const exported = resolveExport(first, rest)
        if (exported !== null) return exported
        if (localIds.includes(first)) return `{${prefix}_${first}.${rest}}`
        return match
      })
  }
  if (Array.isArray(value)) {
    // undefined entries are legal in param data and drop out at JSON round-trips.
    return value.map((item) => substituteParams(item, provided, prefix, localIds, resolveExport)) as JsonValue
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteParams(item, provided, prefix, localIds, resolveExport) as JsonValue
    }
    return out
  }
  return value
}

const INLINE_ROUTE_DEFAULTS: Record<string, Partial<Record<RouteKey, RouteValue>>> = {
  shell: { on_success: 'next', on_failure: 'abort' },
  interrupt: { on_approve: 'next', on_reject: 'abort' },
  handoff: { on_success: 'next', on_failure: 'abort' },
  conditional: { on_true: 'next', on_false: 'abort' },
  agent_delegate: { on_success: 'next', on_failure: 'abort' },
  agent_resume: { on_success: 'next' },
}

function buildRefStep(
  def: SubflowDef,
  step: StepDef,
  prefix: string,
  provided: Record<string, JsonValue | undefined>,
  resolveExport: ExportResolver,
): ExpandedStep {
  const localIds = def.steps.map((entry) => entry.id)
  const params = (substituteParams(step.params as JsonValue | undefined, provided, prefix, localIds, resolveExport) ?? {}) as Record<string, JsonValue>
  const expanded: ExpandedStep = { id: `${prefix}_${sanitize(step.id)}`, type: step.type, params }
  for (const key of ROUTE_KEYS[step.type]) {
    const target = (step as unknown as Record<string, JsonValue>)[key]
    if (typeof target === 'string') {
      expanded[key] = target === 'next' || target === 'done' || target === 'abort' ? target : `${prefix}_${sanitize(target)}`
    }
  }
  return expanded
}

function buildInlineStep(spec: AtomicSpec, id: string): ExpandedStep {
  const inline = spec as { type: StepDef['type']; params?: Record<string, JsonValue> }
  const step: ExpandedStep = { id, type: inline.type, params: inline.params ?? {} }
  for (const [key, fallback] of Object.entries(INLINE_ROUTE_DEFAULTS[inline.type] ?? {})) {
    const explicit = (inline as unknown as Record<string, JsonValue>)[key]
    step[key as RouteKey] = typeof explicit === 'string' && explicit.length > 0 ? explicit : fallback
  }
  return step
}

function truncate(text: unknown, max: number): string {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** Render the human-reviewable plan for a pre_start_gate message. */
export function planText(steps: ExpandedStep[]): string {
  const lines = ['The following workflow plan is about to run (snapshot: what you approve is exactly what executes). No actual work starts until approval:']
  steps.forEach((step, index) => {
    const params = step.params ?? {}
    let summary: string
    switch (step.type) {
      case 'shell':
        summary = `command=${truncate(params.command, 120)}${params.expect ? `  expect=${truncate(params.expect, 120)}` : '  ⚠️ no expect check'}`
        break
      case 'interrupt':
        summary = `human gate: ${truncate(params.message, 120)}`
        break
      case 'handoff':
        summary = `handoff to orchestrator: ${truncate(params.task_hint, 120)}`
        break
      case 'conditional':
        summary = `condition: ${truncate(params.expr, 120)}`
        break
      default:
        summary = truncate(JSON.stringify(params), 120)
    }
    lines.push(`${index + 1}. [${step.id}] ${step.type} — ${summary}`)
  })
  return lines.join('\n')
}

/**
 * Expand an ordered `atomics` list into a flat workflow.
 *
 * @throws {@link InvalidAtomicsError} for malformed entries
 * @throws {@link UnknownSubflowError} for unregistered names
 * @throws {@link MissingParamError} for missing required params
 * @throws {@link InvalidSubflowError} (via validation) for broken definitions
 */
export function expandDynamic(atomics: AtomicSpec[], registry: SubflowRegistry): ExpandedWorkflow {
  if (!Array.isArray(atomics) || atomics.length === 0) {
    throw new InvalidAtomicsError('atomics must be a non-empty array')
  }

  // Pass 1 — assign prefixes; duplicate Ref names get index suffixes so
  // their steps never collide (mirrors the gatedflow duplicate-Ref fix).
  // `nameToPrefix` keeps the FIRST prefix per subflow name for export
  // resolution; `prefixes[i]` is the exact prefix of atomics[i] (duplicates
  // are distinct and unambiguous).
  const nameToPrefix = new Map<string, string>()
  const nameCount = new Map<string, number>()
  const prefixes: string[] = []
  for (const atomic of atomics) {
    if (!isRef(atomic)) {
      prefixes.push('')
      continue
    }
    const basePrefix = sanitize(atomic.name)
    const count = (nameCount.get(basePrefix) ?? 0) + 1
    nameCount.set(basePrefix, count)
    const prefix = count === 1 ? basePrefix : `${basePrefix}_${count}`
    prefixes.push(prefix)
    if (!nameToPrefix.has(atomic.name)) nameToPrefix.set(atomic.name, prefix)
  }

  // Cross-subflow export rewrite: `{subflow.export}` → `{prefix_local.field}`.
  const resolveExport: ExportResolver = (subflowName, exportName) => {
    const target = registry.get(subflowName)
    if (target === undefined) return null
    const spec = target.exports?.[exportName]
    if (spec === undefined || typeof spec.from !== 'string') return null
    const targetPrefix = nameToPrefix.get(subflowName)
    if (targetPrefix === undefined) return null
    const dot = spec.from.indexOf('.')
    const local = dot >= 0 ? spec.from.slice(0, dot) : spec.from
    const field = dot >= 0 ? spec.from.slice(dot + 1) : ''
    return `{${targetPrefix}_${sanitize(local)}${field ? `.${field}` : ''}}`
  }

  // Pass 2 — build prefixed steps.
  const steps: Record<string, ExpandedStep> = {}
  const stepOrder: string[] = []
  const entries: string[] = []
  let inlineCount = 0

  for (const [index, atomic] of atomics.entries()) {
    if (atomic === null || typeof atomic !== 'object') {
      throw new InvalidAtomicsError(`atomics[${index}] is invalid`)
    }
    if (isRef(atomic)) {
      const def = registry.get(atomic.name)
      if (def === undefined) throw new UnknownSubflowError(atomic.name)
      assertValidSubflow(def)
      const prefix = prefixes[index]!
      const provided = effectiveParams(def, atomic.params)
      let first: string | null = null
      for (const stepDef of def.steps) {
        const step = buildRefStep(def, stepDef, prefix, provided, resolveExport)
        if (first === null) first = step.id
        steps[step.id] = step
        stepOrder.push(step.id)
      }
      entries.push(first!)
    } else {
      const type = (atomic as { type?: unknown }).type
      if (typeof type !== 'string' || !(Object.keys(INLINE_ROUTE_DEFAULTS) as string[]).includes(type)) {
        throw new InvalidAtomicsError(`atomics[${index}]: unsupported inline step type "${String(type)}"`)
      }
      inlineCount++
      const id = `inline${inlineCount}_inline_${sanitize(type)}_${inlineCount}`
      const step = buildInlineStep(atomic, id)
      steps[step.id] = step
      stepOrder.push(step.id)
      entries.push(id)
    }
  }

  // Wire `next` routes to the following atomic block's entry (or done).
  const routeKeysFor = (type: string): readonly string[] => (ROUTE_KEYS as Record<string, readonly string[]>)[type] ?? []
  for (const id of stepOrder) {
    const step = steps[id]!
    for (const key of routeKeysFor(step.type)) {
      if (step[key as RouteKey] === 'next') {
        const entryIndex = stepOrder.indexOf(id)
        let target: string = 'done'
        for (const entry of entries) {
          if (stepOrder.indexOf(entry) > entryIndex) {
            target = entry
            break
          }
        }
        step[key as RouteKey] = target
      }
    }
  }

  steps['done'] = { id: 'done', type: 'done', params: {} }
  stepOrder.push('done')

  let entry = entries[0] ?? 'done'
  const isPath1 = atomics.length === 1 && isRef(atomics[0]!)
  let wrapped = false

  if (!isPath1) {
    wrapped = true
    const plan = planText(stepOrder.filter((id) => id !== 'done').map((id) => steps[id]!))
    const gate: ExpandedStep = {
      id: 'pre_start_gate',
      type: 'interrupt',
      params: { header: 'gatedflow gate · plan approval', message: plan },
      on_approve: entry,
      on_reject: 'abort',
    }
    steps['pre_start_gate'] = gate
    stepOrder.unshift('pre_start_gate')
    entry = 'pre_start_gate'
  }

  return { steps: steps as Record<string, ExpandedStep>, stepOrder, entry, wrapped }
}
