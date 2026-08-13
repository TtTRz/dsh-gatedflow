/**
 * Service adapters: bridge the engine's small interfaces to DSH services.
 *
 * Every class here is a pure dependency-inversion seam — the engine core
 * knows nothing about DeepSeek Harness; these adapters translate.
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor, ShellExecRequest } from '@deepseek-ai/dsh-shell'
import type {
  AuditRecord,
  AuditSink,
  DeadlineTimer,
  ShellRequest,
  ShellRunResult,
  ShellRunner,
  WorkflowRuntimeState,
  WorkflowStore,
} from '@gatedflow/engine'

/** Structural view of the subprocess collected-output shape (text + spill). */
interface CollectedOutputLike {
  text?: string
  spillPath?: string | null
}

/** Executes shell steps through the DSH bash executor seam. */
export class DshShellRunner implements ShellRunner {
  constructor(private readonly shell: ShellExecutor) {}

  async run(request: ShellRequest): Promise<ShellRunResult> {
    const execRequest: ShellExecRequest = { command: request.command, timeoutMs: request.timeoutMs }
    if (request.workdir !== undefined) execRequest.workdir = request.workdir
    if (request.signal !== undefined) execRequest.signal = request.signal
    const result = await this.shell.run(this.shell.resolve(execRequest))
    const stdout = result.stdout as unknown as CollectedOutputLike
    const stderr = result.stderr as unknown as CollectedOutputLike
    return {
      exitCode: result.exitCode,
      stdout: stdout.text ?? '',
      stderr: stderr.text ?? '',
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdoutSpill: stdout.spillPath ?? null,
      stderrSpill: stderr.spillPath ?? null,
    }
  }
}

/**
 * Persists full runtime state as JSON files under `<dir>/<workflow_id>.json`
 * through the DSH filesystem service (atomic create/replace).
 */
export class FsWorkflowStore implements WorkflowStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
  ) {}

  async save(state: WorkflowRuntimeState): Promise<void> {
    const target = await this.fs.resolve(`${this.dir.replace(/\/+$/, '')}/${state.workflow_id}.json`)
    await this.fs.writeText(target, JSON.stringify(state, null, 2))
  }

  /** Load one persisted state record (missing/corrupt files yield null). */
  async load(workflowId: string): Promise<WorkflowRuntimeState | null> {
    const target = await this.fs.resolve(`${this.dir.replace(/\/+$/, '')}/${workflowId}.json`)
    try {
      return JSON.parse(await this.fs.readText(target)) as WorkflowRuntimeState
    } catch {
      return null
    }
  }

  /** List workflow ids present in the store directory. */
  async listIds(): Promise<string[]> {
    const target = await this.fs.resolve(this.dir)
    let entries
    try {
      entries = await this.fs.listDir(target)
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
  }
}

/**
 * Audit batcher: buffers engine audit records per workflow and flushes them
 * as appended JSONL with a bounded tail (`tailLines` lines). The DSH
 * filesystem service has no append primitive, so each flush rewrites the
 * bounded file — per-flush cost stays constant regardless of workflow length.
 */
export class BoundedTailAuditSink {
  private readonly buffers = new Map<string, AuditRecord[]>()
  private readonly flushTimers = new Map<string, () => void>()

  constructor(
    private readonly fs: FileSystem,
    private readonly dir: string,
    private readonly timeout: (callback: () => void, delay: number) => () => void,
    private readonly flushDelayMs = 700,
    private readonly tailLines = 500,
  ) {}

  /** Create the engine audit sink: routes records to their workflow's buffer. */
  sink(): AuditSink {
    return (workflowId, record) => {
      this.queueFor(workflowId, record)
    }
  }

  queueFor(workflowId: string, record: AuditRecord): void {
    const buffer = this.buffers.get(workflowId) ?? []
    buffer.push(record)
    this.buffers.set(workflowId, buffer)
    if (!this.flushTimers.has(workflowId)) {
      const disposer = this.timeout(() => {
        this.flushTimers.delete(workflowId)
        void this.flush(workflowId)
      }, this.flushDelayMs)
      this.flushTimers.set(workflowId, disposer)
    }
    if (record.event === 'completed' || record.event === 'failed' || record.event === 'killed' || record.event === 'gate_timeout') {
      void this.flush(workflowId)
    }
  }

  async flush(workflowId: string): Promise<void> {
    const disposer = this.flushTimers.get(workflowId)
    if (disposer !== undefined) {
      disposer()
      this.flushTimers.delete(workflowId)
    }
    const buffer = this.buffers.get(workflowId)
    if (buffer === undefined || buffer.length === 0) return
    this.buffers.delete(workflowId)
    const path = `${this.dir.replace(/\/+$/, '')}/${workflowId}.jsonl`
    const target = await this.fs.resolve(path)
    let existing = ''
    try {
      existing = await this.fs.readText(target)
    } catch {
      // First write.
    }
    const merged = `${existing ? `${existing}\n` : ''}${buffer.map((record) => JSON.stringify(record)).join('\n')}`
    const tail = `${merged.split('\n').filter((line) => line.length > 0).slice(-this.tailLines).join('\n')}\n`
    await this.fs.writeText(target, tail)
  }

  dispose(): void {
    for (const disposer of this.flushTimers.values()) disposer()
    this.flushTimers.clear()
    this.buffers.clear()
  }
}

/** Deadline timer over the DSH timer mixin (`ctx.timeout(callback, ms)`). */
export function dshDeadlineTimer(timeout: (callback: () => void, delay: number) => () => void): DeadlineTimer {
  return { set: (milliseconds, callback) => timeout(callback, milliseconds) }
}
