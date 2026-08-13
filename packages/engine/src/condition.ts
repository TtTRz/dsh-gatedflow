/**
 * Deterministic conditional expressions (gatedflow D9).
 *
 * The engine never judges natural-language semantics — LLMs do that on the
 * agent side and report *structured fields*. This evaluator decides only
 * over deterministic operators applied to step outputs.
 *
 * Grammar (fixed operators, deliberately not Turing-complete):
 *
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := not ( '&&' not )*
 *   not     := '!' not | primary
 *   primary := '(' expr ')' | operand (op operand)?
 *   operand := '{ref}' | string | number | true | false | null | bareword
 *   op      := '==' | '!=' | '>=' | '<=' | '>' | '<' | 'contains'
 *
 * `{ref}` resolves against step outputs with dot paths, e.g.
 * `{gather.result.found}`.
 */

import { ConditionParseError } from './errors.js'
import type { JsonValue } from './types.js'

/** Operators, longest first so `>=` wins over `>`. */
const OPERATORS = ['==', '!=', '>=', '<=', 'contains', '>', '<'] as const
type Operator = (typeof OPERATORS)[number]

function compare(op: Operator, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==':
      // Deliberately loose: structured fields mix number/string/bool.
      // eslint-disable-next-line eqeqeq
      return left == right
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right
    case '>':
      return Number(left) > Number(right)
    case '<':
      return Number(left) < Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case 'contains':
      if (left === null || left === undefined) return false
      if (Array.isArray(left)) return left.some((item) => String(item) === String(right))
      return String(left).includes(String(right))
  }
}

class Parser {
  private index = 0

  constructor(
    private readonly source: string,
    private readonly resolve: (ref: string) => unknown,
  ) {}

  evaluate(): boolean {
    const value = this.parseOr()
    this.skipWhitespace()
    if (this.index < this.source.length) {
      throw new ConditionParseError(`unexpected token at position ${this.index}: "${this.source.slice(this.index)}"`)
    }
    return Boolean(value)
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) {
      this.index++
    }
  }

  private parseOr(): unknown {
    let value = this.parseAnd()
    this.skipWhitespace()
    while (this.source.startsWith('||', this.index)) {
      this.index += 2
      value = Boolean(value) || Boolean(this.parseAnd())
    }
    return value
  }

  private parseAnd(): unknown {
    let value = this.parseNot()
    this.skipWhitespace()
    while (this.source.startsWith('&&', this.index)) {
      this.index += 2
      value = Boolean(value) && Boolean(this.parseNot())
    }
    return value
  }

  private parseNot(): unknown {
    this.skipWhitespace()
    if (this.source[this.index] === '!') {
      this.index++
      return !this.parseNot()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): unknown {
    this.skipWhitespace()
    if (this.source[this.index] === '(') {
      this.index++
      const value = this.parseOr()
      this.skipWhitespace()
      if (this.source[this.index] !== ')') {
        throw new ConditionParseError(`expected ")" at position ${this.index}`)
      }
      this.index++
      return value
    }

    const left = this.parseOperand()
    this.skipWhitespace()
    for (const op of OPERATORS) {
      if (this.source.startsWith(op, this.index)) {
        this.index += op.length
        return compare(op, left, this.parseOperand())
      }
    }
    return Boolean(left)
  }

  private parseOperand(): unknown {
    this.skipWhitespace()
    const char = this.source[this.index]
    if (char === undefined) {
      throw new ConditionParseError(`unexpected end of expression at position ${this.index}`)
    }

    // Step-output reference.
    if (char === '{') {
      const end = this.source.indexOf('}', this.index)
      if (end < 0) throw new ConditionParseError(`unclosed reference at position ${this.index}`)
      const ref = this.source.slice(this.index + 1, end)
      this.index = end + 1
      return this.resolve(ref)
    }

    // Quoted string.
    if (char === '"' || char === "'") {
      const quote = char
      this.index++
      let out = ''
      while (this.index < this.source.length && this.source[this.index] !== quote) {
        out += this.source[this.index]
        this.index++
      }
      if (this.source[this.index] !== quote) {
        throw new ConditionParseError(`unclosed string at position ${this.index}`)
      }
      this.index++
      return out
    }

    // Number.
    const numberMatch = /^-?\d+(\.\d+)?/.exec(this.source.slice(this.index))
    if (numberMatch) {
      this.index += numberMatch[0].length
      return Number.parseFloat(numberMatch[0])
    }

    // Bareword literals (true/false/null) or a bare string operand.
    const wordMatch = /^[A-Za-z_]\w*/.exec(this.source.slice(this.index))
    if (wordMatch) {
      this.index += wordMatch[0].length
      switch (wordMatch[0]) {
        case 'true':
          return true
        case 'false':
          return false
        case 'null':
          return null
        default:
          return wordMatch[0]
      }
    }

    throw new ConditionParseError(`cannot parse operand at position ${this.index}: "${this.source.slice(this.index)}"`)
  }
}

/**
 * Evaluate a deterministic expression against step outputs.
 *
 * @throws {@link ConditionParseError} when the expression is malformed.
 */
export function evalCondition(expr: string, outputs: Record<string, JsonValue>): boolean {
  const parser = new Parser(expr, (ref) => lookupRef(ref, outputs))
  return parser.evaluate()
}

/** Resolve a dotted reference like `step.field.nested` against outputs. */
export function lookupRef(ref: string, outputs: Record<string, JsonValue>): unknown {
  const parts = ref.split('.')
  let current: unknown = outputs
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Replace `{step.field}` references in a runtime string with the resolved
 * value from step outputs. Missing references become empty strings; objects
 * are rendered as compact JSON.
 */
export function substituteRuntime(text: string, outputs: Record<string, JsonValue>): string {
  return text.replace(/\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g, (match, ref: string) => {
    const value = lookupRef(ref, outputs)
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  })
}
