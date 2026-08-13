/**
 * DeepSeek Harness host adapter for the gatedflow engine.
 *
 * Wires the pure engine to DSH services:
 * - `ctx.shell`   → shell steps (DshShellRunner)
 * - `ctx.fs`      → workflow state + audit persistence (FsWorkflowStore, BoundedTailAuditSink)
 * - `ctx.tools`   → the 7 model-facing `gf_*` tools + the anti-bypass guard
 * - `ctx.timer`   → gate deadlines, audit flush debounce, agent-step timeouts
 * - `ctx.subagents` → agent_delegate / agent_resume child execution
 *
 * The gate panel transport is NOT registered here: `webServer` routes are
 * process-global, so they belong to the host-composition gateway row
 * (`@gatedflow/dsh/gateway`), which this row reaches through the shared
 * transport hub. Human gate decisions travel exclusively through that
 * transport: the model-facing `gf_advance` schema has no approve/reject
 * values, and a tool guard blocks them anyway. The agent cannot decide
 * gates.
 */

import path from 'node:path'
import '@deepseek-ai/cordis-plugin-timer'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  WorkflowRuntime,
  type AdvanceDecision,
  type AtomicSpec,
  type EngineServices,
  type JsonValue,
  type SubflowDef,
  type WorkflowRuntimeState,
} from '@gatedflow/engine'
import { DslRegistry } from './registry.js'
import { BoundedTailAuditSink, DshShellRunner, FsWorkflowStore, dshDeadlineTimer } from './services.js'
import { DshAgentExecutor } from './agent-executor.js'
import { attachBoard, type GateRecord, type GatedflowBoard, type WorkflowRecord } from './transport.js'

// -------------------------------------------------------------- subflows

const VERIFY_DEMO: SubflowDef = {
  name: 'gf-verify-demo',
  description: 'Demo of the gate loop: shell+expect verification → interrupt human gate (panel approval) → publish. A single Ref runs the deterministic path (no pre_start_gate wrapper).',
  keywords: ['demo', 'gate', 'human-review', 'verification'],
  params: { note: { required: false, description: 'Extra note carried into the artifact' } },
  steps: [
    { id: 'prep', type: 'shell', params: { command: 'echo "prep ok ${note}"', expect: 'true' }, on_success: 'check', on_failure: 'abort' },
    { id: 'check', type: 'shell', params: { command: 'mkdir -p .gatedflow/demo && echo "artifact: built $(date +%s)" > .gatedflow/demo/artifact.txt', expect: 'test -f .gatedflow/demo/artifact.txt' }, on_success: 'review', on_failure: 'abort' },
    { id: 'review', type: 'interrupt', params: { header: 'gatedflow gate', message: 'The artifact was generated and passed verification (.gatedflow/demo/artifact.txt).\nConfirm to continue publishing?' }, on_approve: 'ship', on_reject: 'abort' },
    { id: 'ship', type: 'shell', params: { command: 'echo "SHIPPED: $(cat .gatedflow/demo/artifact.txt)"', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
  ],
}

const RESEARCH: SubflowDef = {
  name: 'gf-research',
  description: 'Demo of handoff: a ReAct task is delegated back to the orchestrator; the structured result is then judged by a conditional.',
  keywords: ['handoff', 'research', 'demo'],
  params: { question: { required: true, description: 'The research question' } },
  steps: [
    { id: 'gather', type: 'handoff', params: { task_hint: 'Research and answer: ${question}. When done, call gf_advance(handoff_complete, result={found: true/false, answer: "..."}).' }, on_success: 'judge', on_failure: 'abort' },
    { id: 'judge', type: 'conditional', params: { expr: '{gather.result.found} == true' }, on_true: 'report_ok', on_false: 'abort' },
    { id: 'report_ok', type: 'shell', params: { command: 'echo "ANSWER: {gather.result.answer}"', expect: 'true' }, on_success: 'next', on_failure: 'abort' },
  ],
}

// ------------------------------------------------------------------ tools

function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  return text.length > 50000 ? `${text.slice(0, 50000)}\n...(truncated, ${text.length - 50000} more chars)` : text
}

function toolOutput() {
  return {
    schema: { type: 'object' as const, additionalProperties: true as const },
    render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: jsonText(value) }],
  }
}

/** Canonical tool results are plain JSON records; cast through unknown once. */
function asRecord(value: unknown): Record<string, JsonValue> {
  return value as Record<string, JsonValue>
}

interface AgentLike {
  session?: { header?: { cwd?: string } }
}

function agentCwd(exec: ToolRunContext | undefined): string | undefined {
  const agent = exec?.agent as unknown as AgentLike | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** Per-workspace subflow roots for the calling session (workspace wins over shared dirs). */
function workspaceSubflowDirs(exec: ToolRunContext | undefined): string[] {
  const cwd = agentCwd(exec)
  return cwd !== undefined ? [path.join(cwd, '.gatedflow', 'subflows')] : []
}

// ---------------------------------------------------------------- plugin

export const name = '@gatedflow/dsh'
export const inject = ['fs', 'shell', 'tools', 'timer', 'subagents']

/** Plugin config. All optional — `Config` supplies the defaults. */
export interface Config {
  /**
   * Shared subflow root (read-only for this plugin). Workflow state and audit
   * live per workspace under `<workspace_root>/.gatedflow` — the sandbox's
   * workspace-write policy denies writes outside the workspace.
   */
  stateDir?: string
  /** Additional subflow directories appended to the default one. */
  subflowDirs?: string[]
  /** Default gate deadline in seconds (steps may override). */
  gateDeadlineSecs?: number
  /** Default shell step timeout in milliseconds (steps may override). */
  shellTimeoutMs?: number
  /** Bounded audit tail length in lines. */
  auditTailLines?: number
  /** `ctx.subagents` provider name used for agent_delegate/agent_resume steps. */
  subagentProvider?: string
}

export interface ResolvedConfig {
  stateDir: string
  subflowDirs: string[]
  gateDeadlineSecs: number
  shellTimeoutMs: number
  auditTailLines: number
  subagentProvider: string
}

function defaultStateDir(): string {
  return process.env.GATEDFLOW_STATE_DIR ?? path.join(process.env.HOME ?? '/tmp', '.gatedflow')
}

export const Config = z.object({
  stateDir: z.string().default(defaultStateDir()),
  subflowDirs: z.array(z.string()).default([]),
  gateDeadlineSecs: z.number().default(1800),
  shellTimeoutMs: z.number().default(120000),
  auditTailLines: z.number().default(500),
  subagentProvider: z.string().default('spawn'),
})

function resolvedConfig(raw: Config | undefined): ResolvedConfig {
  const config = raw ?? {}
  return {
    stateDir: config.stateDir ?? defaultStateDir(),
    subflowDirs: config.subflowDirs ?? [],
    gateDeadlineSecs: config.gateDeadlineSecs ?? 1800,
    shellTimeoutMs: config.shellTimeoutMs ?? 120000,
    auditTailLines: config.auditTailLines ?? 500,
    subagentProvider: config.subagentProvider ?? 'spawn',
  }
}

export function apply(ctx: Context, config?: Config): void {
  const fs = ctx.fs
  const shell = ctx.shell
  const tools = ctx.tools
  const timeout = (callback: () => void, delay: number) => ctx.timeout(callback, delay)

  const resolved = resolvedConfig(config)
  const stateDir = resolved.stateDir
  const subflowDirs = [path.join(stateDir, 'subflows'), ...resolved.subflowDirs]
  const extraSubflowDir = process.env.GATEDFLOW_SUBFLOWS_DIR
  if (extraSubflowDir !== undefined) subflowDirs.push(extraSubflowDir)

  // Best-effort directory creation (the fs service has no mkdir primitive).
  for (const dir of [subflowDirs[0]!]) {
    void shell.run(shell.resolve({ command: `mkdir -p ${JSON.stringify(dir)}`, timeoutMs: 15000 }))
  }

  const registry = new DslRegistry(fs, subflowDirs)
  registry.registerBuiltin(VERIFY_DEMO)
  registry.registerBuiltin(RESEARCH)

  const runtimes = new Map<string, WorkflowRuntime>()
  const disposers: (() => void)[] = []
  // One executor shared by every runtime; its calling identity (exec.agent /
  // exec.signal) is re-bound at the start of each tool call that runs steps.
  const agentExecutor = new DshAgentExecutor({ ctx, provider: resolved.subagentProvider, timer: timeout })

  // Per-workspace persistence. The sandbox's workspace-write policy denies
  // writes outside the session workspace (reads are fine), so workflow state
  // and audit live under `<workspace_root>/.gatedflow` — writable by
  // construction — while `stateDir` remains the shared SUBFLOW root (read-only
  // for this plugin). `GATEDFLOW_STATE_DIR`/config can point `stateDir`
  // anywhere because only reads happen there.
  const workspaceServices = new Map<string, { store: FsWorkflowStore; sink: BoundedTailAuditSink }>()
  function workspaceStateOf(workspaceRoot: string) {
    const key = workspaceRoot.replace(/\/+$/, '')
    const existing = workspaceServices.get(key)
    if (existing !== undefined) return existing
    const base = path.join(workspaceRoot, '.gatedflow')
    const entry = {
      store: new FsWorkflowStore(fs, path.join(base, 'workflows')),
      sink: new BoundedTailAuditSink(fs, path.join(base, 'audit'), timeout, 700, resolved.auditTailLines),
    }
    workspaceServices.set(key, entry)
    void shell.run(shell.resolve({
      command: `mkdir -p ${JSON.stringify(path.join(base, 'workflows'))} ${JSON.stringify(path.join(base, 'audit'))}`,
      timeoutMs: 15000,
    }))
    return entry
  }

  function engineServices(workspaceRoot: string): EngineServices {
    const workspace = workspaceStateOf(workspaceRoot)
    return {
      registry,
      shell: new DshShellRunner(shell),
      store: workspace.store,
      timer: dshDeadlineTimer(timeout),
      audit: workspace.sink.sink(),
      agent: agentExecutor,
      defaultGateDeadlineSecs: resolved.gateDeadlineSecs,
      defaultShellTimeoutMs: resolved.shellTimeoutMs,
    }
  }

  /** Rebuild a persisted workflow from its workspace store (restore semantics). */
  async function restoreFromWorkspace(workspaceRoot: string, workflowId: string): Promise<WorkflowRuntime | null> {
    const workspace = workspaceStateOf(workspaceRoot)
    const state = await workspace.store.load(workflowId)
    if (state === null) return null
    const runtime = WorkflowRuntime.restore(engineServices(state.workspace_root), state as WorkflowRuntimeState)
    runtimes.set(workflowId, runtime)
    workspace.sink.queueFor(workflowId, { ts: new Date().toISOString(), event: 'reconcile', data: { workflow_id: workflowId, from: state.status } })
    return runtime
  }

  function requireRuntime(workflowId: unknown): WorkflowRuntime {
    if (typeof workflowId !== 'string') throw new Error('workflow_id must be a string')
    const runtime = runtimes.get(workflowId)
    if (runtime === undefined) throw new Error(`unknown workflow: ${workflowId}`)
    return runtime
  }

  // -------------------------------------------------------------- gf_start

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_start',
        description:
          'Start a gatedflow workflow (the only entry point). atomics with a single Ref = run the named preset (deterministic path, no gate wrapper); multiple entries / Inline = dynamic composition (a pre_start_gate is wrapped automatically). When workflow_id matches a workflow persisted in the workspace, its state RESTORES instead of starting fresh (running restores as paused; terminal verbatim) — atomics are then ignored. When an interrupt gate pauses, an approval card appears in the gate panel above the composer and the user clicks Approve/Reject — the agent has no decision power. The tool returns the paused snapshot with the gate.',
        parameters: {
          atomics: { type: 'array', required: true, description: 'Ordered subflow spec list: each entry is {name, params} (reference to a named subflow) or {type, params} (inline shell/interrupt/handoff/conditional)' },
          workflow_id: { type: 'string', description: 'Optional workflow id (auto-generated by default)' },
          workspace_root: { type: 'string', description: 'Optional workflow working directory (defaults to the session workspace)' },
        },
        timeoutMs: 3600000,
        output: toolOutput(),
        async execute(args, exec) {
          const explicitWorkspace = typeof args.workspace_root === 'string' ? args.workspace_root : agentCwd(exec)
          await registry.reload(explicitWorkspace !== undefined ? [path.join(explicitWorkspace, '.gatedflow', 'subflows')] : [])
          agentExecutor.bind(exec.agent, exec.signal)
          const atomics = (args.atomics ?? []) as AtomicSpec[]
          const workspaceRoot = explicitWorkspace ?? stateDir
          const requestedId = typeof args.workflow_id === 'string' ? args.workflow_id : undefined
          // A known workflow id restores its persisted state instead of
          // starting fresh (running states come back paused; terminal states
          // verbatim — the engine's restore contract).
          if (requestedId !== undefined && !runtimes.has(requestedId)) {
            const restored = await restoreFromWorkspace(workspaceRoot, requestedId)
            if (restored !== null) return asRecord(restored.snapshot())
          }
          const runtime = await WorkflowRuntime.start(engineServices(workspaceRoot), {
            workflowId: requestedId,
            atomics,
            workspaceRoot,
          })
          runtimes.set(runtime.workflowId, runtime)
          return asRecord(runtime.snapshot())
        },
      }),
    ),
  )

  // ------------------------------------------------------------- gf_advance

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_advance',
        description:
          'Advance a paused gatedflow workflow. decision: retry (re-run the failed step, prior outputs kept) / handoff_complete / handoff_fail (return the handoff result). Human decisions on interrupt gates go exclusively through the session gate panel (dock card buttons), never through this tool (a guard blocks them). After a /stop interruption, call without a decision to resume the current step. When running, returns the current status.',
        parameters: {
          workflow_id: { type: 'string', required: true, description: 'Workflow id' },
          decision: { type: 'string', enum: ['retry', 'handoff_complete', 'handoff_fail'], description: 'See the tool description' },
          reason: { type: 'string', description: 'Failure reason (for handoff_fail)' },
          result: { type: 'object', additionalProperties: true, description: 'Structured result returned on handoff_complete' },
        },
        timeoutMs: 3600000,
        output: toolOutput(),
        async execute(args, exec) {
          const runtime = requireRuntime(args.workflow_id)
          agentExecutor.bind(exec.agent, exec.signal)
          const decision = typeof args.decision === 'string' ? (args.decision as AdvanceDecision) : undefined
          return asRecord(await runtime.advance(decision, (args.result ?? undefined) as JsonValue | undefined, typeof args.reason === 'string' ? args.reason : undefined))
        },
      }),
    ),
  )

  // ------------------------------------------------------------- gf_status

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_status',
        description: 'Read-only status summary of a gatedflow workflow (status, current step, completed steps, gate).',
        parameters: { workflow_id: { type: 'string', required: true, description: 'Workflow id' } },
        timeoutMs: 60000,
        output: toolOutput(),
        async execute(args) {
          return asRecord(requireRuntime(args.workflow_id).snapshot())
        },
      }),
    ),
  )

  // ------------------------------------------------------------ gf_outputs

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_outputs',
        description: 'Read step outputs of a gatedflow workflow. Optional step_id reads a single step.',
        parameters: {
          workflow_id: { type: 'string', required: true, description: 'Workflow id' },
          step_id: { type: 'string', description: 'Optional step id (e.g. gf_research_gather)' },
        },
        timeoutMs: 60000,
        output: toolOutput(),
        async execute(args) {
          const runtime = requireRuntime(args.workflow_id)
          const outputs = runtime.outputs()
          if (typeof args.step_id === 'string') {
            return asRecord({ workflow_id: runtime.workflowId, step_id: args.step_id, output: outputs[args.step_id] ?? null })
          }
          return asRecord({ workflow_id: runtime.workflowId, step_outputs: outputs })
        },
      }),
    ),
  )

  // -------------------------------------------------------------- gf_kill

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_kill',
        description: 'Terminate a gatedflow workflow (called when the human asks to stop; human-driven under zero-mutation).',
        parameters: {
          workflow_id: { type: 'string', required: true, description: 'Workflow id' },
          reason: { type: 'string', description: 'Termination reason' },
        },
        timeoutMs: 60000,
        output: toolOutput(),
        async execute(args) {
          const runtime = requireRuntime(args.workflow_id)
          return asRecord(await runtime.kill(typeof args.reason === 'string' ? args.reason : undefined))
        },
      }),
    ),
  )

  // -------------------------------------------------------- gf_list_subflows

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_list_subflows',
        description: 'List every available subflow: name + description + keywords + params + exports (for matching intent when composing atomics).',
        parameters: {},
        timeoutMs: 60000,
        output: toolOutput(),
        async execute(_args, exec) {
          await registry.reload(workspaceSubflowDirs(exec))
          return asRecord({ subflows: registry.summaries() })
        },
      }),
    ),
  )

  // ------------------------------------------------------ gf_reload_subflows

  disposers.push(
    tools.register(
      defineTool({
        name: 'gf_reload_subflows',
        description: 'Re-scan the subflow directories (hot reload); new or edited subflow files take effect immediately.',
        parameters: {},
        timeoutMs: 60000,
        output: toolOutput(),
        async execute(_args, exec) {
          const count = await registry.reload(workspaceSubflowDirs(exec))
          return asRecord({ count, names: registry.names() })
        },
      }),
    ),
  )

  // --------------------------------------------------------- bypass guard

  disposers.push(
    tools.guard((execution) => {
      if (execution.name !== 'gf_advance') return undefined
      const args = execution.arguments as { decision?: unknown }
      if (args.decision === 'approve' || args.decision === 'reject') {
        return 'gatedflow gate: human decisions on interrupt gates go exclusively through the session gate panel (dock card buttons above the composer); gf_advance does not accept approve/reject. Tell the user a gate is awaiting approval in the panel.'
      }
      return undefined
    }),
  )

  // ------------------------------------------------------- panel transport

  // Attach this instance's workflows to the shared hub; the host-composition
  // gateway row owns the HTTP routes and serves every board. Standing
  // generations coexist until process exit, so the hub aggregates.
  const board: GatedflowBoard = {
    snapshot: () => {
      const gates: GateRecord[] = []
      const workflows: WorkflowRecord[] = []
      for (const runtime of runtimes.values()) {
        const snapshot = runtime.snapshot()
        if (snapshot.status === 'paused' && snapshot.gate !== null) {
          gates.push({
            workflow_id: snapshot.workflow_id,
            step: snapshot.current_step,
            checkpoint_type: snapshot.gate.checkpoint_type,
            header: snapshot.gate.header ?? 'gatedflow gate',
            message: snapshot.gate.message ?? snapshot.gate.task_hint ?? '',
          })
        }
        workflows.push({ workflow_id: snapshot.workflow_id, status: snapshot.status, current_step: snapshot.current_step, error: snapshot.error })
      }
      return { gates, workflows }
    },
    decide: async (workflowId, decision, reason, source) => {
      const runtime = runtimes.get(workflowId)
      if (runtime === undefined) return { ok: false, error: 'unknown workflow' }
      const snapshot = await runtime.decide(decision, reason, source)
      return { ok: true, workflow_id: snapshot.workflow_id, status: snapshot.status, current_step: snapshot.current_step }
    },
  }
  disposers.push(attachBoard(board))

  // --------------------------------------------------------------- cleanup

  ctx.effect(() => () => {
    for (const runtime of runtimes.values()) runtime.dispose()
    runtimes.clear()
    for (const workspace of workspaceServices.values()) workspace.sink.dispose()
    workspaceServices.clear()
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        // Best-effort teardown.
      }
    }
  })
}
