/**
 * Engine error taxonomy.
 *
 * Every failure the engine raises carries a stable machine-readable `code`
 * so orchestrators can branch on error classes instead of parsing messages.
 * Messages stay human-readable for direct relay to users.
 */

export type EngineErrorCode =
  | 'INVALID_SUBFLOW'
  | 'UNKNOWN_SUBFLOW'
  | 'MISSING_PARAM'
  | 'INVALID_ATOMICS'
  | 'DECISION_MISMATCH'
  | 'UNROUTABLE'
  | 'UNKNOWN_STEP_TYPE'
  | 'CONDITION_PARSE'
  | 'INVALID_DECISION'
  | 'WORKFLOW_EXISTS'
  | 'UNKNOWN_WORKFLOW'
  | 'ENGINE_ERROR'

export class GatedflowError extends Error {
  readonly code: EngineErrorCode
  readonly details?: unknown

  constructor(code: EngineErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'GatedflowError'
    this.code = code
    this.details = details
  }
}

/** A subflow definition failed structural validation. */
export class InvalidSubflowError extends GatedflowError {
  constructor(message: string, details?: unknown) {
    super('INVALID_SUBFLOW', message, details)
    this.name = 'InvalidSubflowError'
  }
}

/** A referenced subflow name is not in the registry. */
export class UnknownSubflowError extends GatedflowError {
  constructor(name: string) {
    super('UNKNOWN_SUBFLOW', `unknown subflow: ${name}`)
    this.name = 'UnknownSubflowError'
  }
}

/** Required subflow params were not provided and have no default. */
export class MissingParamError extends GatedflowError {
  constructor(subflow: string, missing: string[]) {
    super('MISSING_PARAM', `subflow ${subflow} is missing required params: ${missing.join(', ')}`, { subflow, missing })
    this.name = 'MissingParamError'
  }
}

/** The `atomics` input was structurally invalid. */
export class InvalidAtomicsError extends GatedflowError {
  constructor(message: string, details?: unknown) {
    super('INVALID_ATOMICS', message, details)
    this.name = 'InvalidAtomicsError'
  }
}

/** An advance/decide call does not match what the paused workflow expects. */
export class DecisionMismatchError extends GatedflowError {
  constructor(message: string, details?: unknown) {
    super('DECISION_MISMATCH', message, details)
    this.name = 'DecisionMismatchError'
  }
}

/** A step routed to a target that does not exist after expansion. */
export class UnroutableError extends GatedflowError {
  constructor(step: string, target: string) {
    super('UNROUTABLE', `step ${step} routed to unknown target: ${target}`, { step, target })
    this.name = 'UnroutableError'
  }
}

/** A conditional expression could not be parsed or evaluated. */
export class ConditionParseError extends GatedflowError {
  constructor(message: string) {
    super('CONDITION_PARSE', message)
    this.name = 'ConditionParseError'
  }
}
