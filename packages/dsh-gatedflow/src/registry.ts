/**
 * Subflow registry: builtin presets plus hot-loadable JSON/YAML files.
 *
 * Files live in `GATEDFLOW_SUBFLOWS_DIR` (or `<workspace>/.gatedflow/subflows`
 * in the engine data dir). Every definition passes structural validation
 * before entering the registry; `reload()` re-scans without a restart.
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { assertValidSubflow, type SubflowDef, type SubflowRegistry, validateSubflow } from '@gatedflow/engine'

export interface SubflowSummary {
  name: string
  description: string
  keywords: string[]
  params: SubflowDef['params']
  exports: SubflowDef['exports']
}

export class DslRegistry implements SubflowRegistry {
  private readonly builtins = new Map<string, SubflowDef>()
  private readonly files = new Map<string, SubflowDef>()

  constructor(
    private readonly fs: FileSystem,
    private readonly dirs: string[],
  ) {}

  registerBuiltin(def: SubflowDef): void {
    const problems = validateSubflow(def)
    if (problems.length > 0) {
      throw new Error(`builtin subflow ${def.name} is invalid: ${problems.join('; ')}`)
    }
    this.builtins.set(def.name, def)
  }

  get(name: string): SubflowDef | undefined {
    return this.files.get(name) ?? this.builtins.get(name)
  }

  names(): string[] {
    return [...this.builtins.keys(), ...this.files.keys()]
  }

  summaries(): SubflowSummary[] {
    const out: SubflowSummary[] = []
    for (const def of [...this.builtins.values(), ...this.files.values()]) {
      out.push({
        name: def.name,
        description: def.description ?? '',
        keywords: def.keywords ?? [],
        params: def.params,
        exports: def.exports,
      })
    }
    return out
  }

  /** Re-scan every configured directory; invalid files are skipped loudly. */
  async reload(): Promise<number> {
    this.files.clear()
    for (const dir of this.dirs) {
      let entries
      try {
        entries = await this.fs.listDir(await this.fs.resolve(dir))
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.name.endsWith('.json') && !entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue
        const target = await this.fs.resolve(`${dir.replace(/\/+$/, '')}/${entry.name}`)
        const raw = await this.fs.readText(target)
        const data: unknown = entry.name.endsWith('.json') ? JSON.parse(raw) : await parseYamlLoose(raw)
        if (data === null || typeof data !== 'object') continue
        const def = data as SubflowDef
        if (typeof def.name !== 'string') {
          console.error(`[gatedflow] subflow file ${entry.name}: missing name, skipped`)
          continue
        }
        try {
          assertValidSubflow(def)
        } catch (error) {
          console.error(`[gatedflow] subflow file ${entry.name}: ${error instanceof Error ? error.message : String(error)}, skipped`)
          continue
        }
        this.files.set(def.name, def)
      }
    }
    return this.files.size
  }
}

/**
 * Minimal YAML subset parser for subflow files (mapping/sequence/scalars).
 * Kept intentionally small: subflows are data and the canonical authoring
 * format in this repo is JSON; YAML support exists for hand-written flows.
 */
export async function parseYamlLoose(raw: string): Promise<unknown> {
  return parseYamlValue(raw)
}

function parseYamlValue(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (text === '' || text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  if (text.startsWith('[')) return parseInlineList(text)
  if (text.startsWith('- ') || text.includes('\n- ')) return parseBlockList(text)
  if (text.includes(': ')) return parseBlockMap(text)
  return text
}

function splitTopLevel(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let indent = -1
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed === '' || trimmed.trim().startsWith('#')) continue
    const level = trimmed.length - trimmed.trimStart().length
    if (indent === -1) indent = level
    if (level === indent) {
      if (current !== '') lines.push(current)
      current = trimmed.trimStart()
    } else {
      current += `\n${trimmed}`
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

function parseBlockMap(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const chunk of splitTopLevel(text)) {
    const colon = chunk.indexOf(':')
    if (colon <= 0) continue
    const key = chunk.slice(0, colon).trim()
    const valueRaw = chunk.slice(colon + 1).trim()
    const value: unknown = valueRaw === '' ? null : parseYamlValue(valueRaw)
    out[key] = value
  }
  return out
}

function parseBlockList(text: string): unknown[] {
  return splitTopLevel(text)
    .filter((chunk) => chunk.startsWith('-'))
    .map((chunk) => parseYamlValue(chunk.replace(/^-/, '').trim()))
}

function parseInlineList(text: string): unknown[] {
  const inner = text.slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((item) => parseYamlValue(item.trim()))
}
