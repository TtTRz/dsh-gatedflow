/**
 * @gatedflow/dsh — DeepSeek Harness adapter for the gatedflow engine.
 *
 * Row layout:
 * - `@gatedflow/dsh` (package main, the gateway module) → Host composition:
 *   panel routes + browser-half anchor. The bare name is required because
 *   `dsh-client-modules` resolves `${entryName}/package.json` for
 *   `dsh.client` discovery — a subpath entry name is never scanned.
 * - `@gatedflow/dsh/host` → agent preset: engine + gf_* tools.
 * - `@gatedflow/dsh/client` → browser half (shipped via `dsh.client`).
 *
 * This module is the helpers barrel, reachable at `@gatedflow/dsh/lib`.
 */

export { apply as host, inject as hostInject, name as hostName } from './host.js'
export { apply as gateway, inject as gatewayInject, name as gatewayName } from './gateway.js'
export { apply as client, inject as clientInject, name as clientName } from './client.js'
export { DslRegistry, type SubflowSummary } from './registry.js'
export { BoundedTailAuditSink, DshShellRunner, FsWorkflowStore, dshDeadlineTimer } from './services.js'
export { DshAgentExecutor, EpochWaiter, type AgentTimer } from './agent-executor.js'
export { attachBoard, decideAcross, queryBoards, type BoardSnapshot, type DecideOutcome, type GateRecord, type GatedflowBoard, type WorkflowRecord } from './transport.js'
