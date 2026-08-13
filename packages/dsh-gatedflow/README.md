# @gatedflow/dsh

DeepSeek Harness adapter for the [gatedflow engine](../engine): the `gf_*`
tools, the gate panel UI, the anti-bypass guard, and filesystem persistence.

The engine core ([`@gatedflow/engine`](../engine)) is framework-agnostic and
contains no LLM; this package is the thin, typed wiring layer over the
harness services.

## Usage

Two rows in two planes. The engine row is per-preset (tools are per-session
registrations); the gateway row is host-plane (the `webServer` route
registry and the browser panel are process-global):

```yaml
# An agent preset (agent.cordis.yml) — engine + gf_* tools per session.
- id: gatedflow
  name: '@gatedflow/dsh/host'
  config:
    stateDir: ~/.gatedflow        # shared subflow root (read-only)
    gateDeadlineSecs: 1800        # default gate timeout
    shellTimeoutMs: 120000        # default shell step timeout
    auditTailLines: 500           # bounded audit tail
    subagentProvider: spawn       # subagents provider for agent steps

# The Host composition (cordis.patch.yml insert) — panel transport + UI.
# The bare package name is REQUIRED: dsh-client-modules discovers the
# browser half through `${entryName}/package.json`, so a subpath name
# (e.g. `@gatedflow/dsh/gateway`) is never scanned.
- id: gatedflow-gateway
  name: '@gatedflow/dsh'
```

The gateway row registers `GET /gatedflow/gates` and `POST /gatedflow/decide`
on the host `webServer` and anchors the browser half, which ships through
the package's `dsh.client` declaration — no separate client row is needed.
The client half registers the gate panel in `conversation.input.dock`,
polls `GET /gatedflow/gates`, and posts human decisions to
`/gatedflow/decide`, which reach the engine directly through the shared
transport hub.

Without the gateway row the engine and tools still work — only the panel
is missing (gates are then followed through `gf_status` instead).

## Config

| Field | Default | Meaning |
|---|---|---|
| `stateDir` | `~/.gatedflow` | Shared subflow root (read-only for this plugin); `subflows/` scans here, and the calling session's `<workspace_root>/.gatedflow/subflows` is scanned as well (workspace wins on name conflicts). Workflow state and audit live per workspace under `<workspace_root>/.gatedflow` — the sandbox's workspace-write policy denies writes outside the workspace. |
| `subflowDirs` | `[]` | Additional shared subflow directories (scanned after `stateDir`, before the workspace dir). |
| `gateDeadlineSecs` | `1800` | Default paused-gate deadline; steps override with `deadline_secs`. |
| `shellTimeoutMs` | `120000` | Default shell step timeout; steps override with `timeout_ms`. |
| `auditTailLines` | `500` | Bounded JSONL audit tail per workflow. |
| `subagentProvider` | `spawn` | `ctx.subagents` provider used for `agent_delegate` / `agent_resume` steps. |
| `panelPollIntervalMs` | `2000` | Client-side gate-panel polling interval. |

Environment overrides: `GATEDFLOW_STATE_DIR` (state root),
`GATEDFLOW_SUBFLOWS_DIR` (extra subflow dir).

## Behavior

- **Gates are control flow.** `interrupt` steps pause the engine and render
  a panel card with **✓ Approve / ✕ Reject**. Decisions travel from the panel
  straight to the engine; the model-facing `gf_advance` schema has no
  approve/reject values and a tool guard blocks them anyway.
- **Zero mutation.** Agents cannot rewrite workflow state, params, or
  routing. Failures take exactly two paths: `pause_on_failure` → pause →
  human repairs → `retry` (prior outputs kept); otherwise `abort` → failed
  → human reviews → new workflow.
- **/stop-safe.** An aborted shell step pauses the workflow (never fails
  it); `gf_advance` without a decision resumes the step in place. Agent
  steps honor the same rule: a cancelled `agent_delegate` / `agent_resume`
  interrupts the child (best effort) and pauses — partial output is kept.
- **Agent steps are continuable children.** `agent_delegate` starts a
  background child through `ctx.subagents.startContinuable` (the durable
  mode the deployment's own delegation tools use) and waits for its initial
  turn via the `subagent/start` / `subagent/end` lifecycle pair; the child
  id is recorded as `{step.child_id}`. `agent_resume` follows that same
  session up with feedback and waits for the next turn. `timeout_ms` (or
  `deadline_secs`) bounds each wait and interrupts the child on expiry.
- **Snapshots.** Subflows are validated at load and snapshotted at start —
  what the human approves is exactly what executes.
- **Hot reload.** New/changed subflow files take effect after
  `gf_reload_subflows`, no restart.
- **Persistence follows the workspace.** Workflow state lands in
  `<workspace_root>/.gatedflow/workflows/<id>.json` and its bounded audit
  tail in `<workspace_root>/.gatedflow/audit/<id>.jsonl` — writable under
  the sandbox's workspace-write policy by construction. `stateDir` supplies
  the shared subflow scan root; each workspace supplies its own
  `.gatedflow/subflows`.
- **Restore on reference.** Calling `gf_start` with a `workflow_id` that is
  persisted in the workspace restores that workflow instead of starting
  fresh: `running` states come back `paused` (their process is gone);
  terminal states restore verbatim.
- **Deadlines.** Every paused gate arms a deadline; expiry fails the
  workflow and records `gate_timeout` in the audit.

## Services consumed

| Service | Usage |
|---|---|
| `fs` | Subflow discovery, workflow state, audit logs |
| `shell` | Shell step execution (`command` + `expect`) |
| `tools` | `gf_*` tool registration + the anti-bypass guard |
| `timer` | Gate deadlines, audit flush debounce, agent-step timeouts |
| `subagents` | `agent_delegate` / `agent_resume` child execution (continuable children + `followup`) |
| `webServer` (gateway row) | Panel routes — `GET /gatedflow/gates`, `POST /gatedflow/decide` (real `WebRoute` contract from `@deepseek-ai/dsh-host-webserver`) |

## Tools

| Tool | Purpose |
|---|---|
| `gf_start` | Start a workflow (the only entry point). Single Ref = deterministic preset; multiple/Inline = dynamic plan wrapped in `pre_start_gate`. |
| `gf_advance` | Advance a paused workflow: `retry` / `handoff_complete` / `handoff_fail`; no decision = resume after interruption. |
| `gf_status` | Read-only status summary. |
| `gf_outputs` | Read step outputs (optionally one step). |
| `gf_kill` | Terminate a workflow (human-driven). |
| `gf_list_subflows` | List subflow metadata for intent matching. |
| `gf_reload_subflows` | Hot-reload the subflow directories. |

## Model Experience

### What the model sees

Seven `gf_*` tools with schemas and descriptions that teach the two-path
(atomics) model, the panel gate protocol, and the zero-mutation discipline.
The model has **no approve/reject channel** — that is the point. When a
workflow pauses at an `interrupt` gate, the tool result carries the paused
snapshot and the user sees the panel card; the agent's job is to relay and
report, never to decide.

### Token effect

Tool schemas are compact; `gf_start` accepts one `atomics` array and the
remaining tools take a `workflow_id` plus one decision enum.

### KV Cache effect

Schemas are static across turns, so definitions stay prefix-stable.

## Known Limitations and Deferred Work

- **The gateway row must be host-composed for the panel.** `webServer`
  routes and the browser half are process-global DSH registries, so the
  panel is delivered by the `@gatedflow/dsh` host row (the package main),
  not by the per-preset engine row. A preset without the host row still
  runs workflows; gates are then followed through `gf_status`.

- **Agent steps resume only within the parent session that delegated.** A
  child's durable `child_id` outlives the tool call, but `followup` requires
  the exact live direct parent, and lifecycle events dispatch to that
  parent's scope — restoring a workflow into a different session cannot
  continue an earlier child (the step fails loudly instead of silently
  mis-delivering).
- **A timed-out delegate leaves its child session durable.** The child is
  interrupted, but the session record remains; retry creates a fresh child
  rather than reusing the orphan.
- **YAML support is a minimal subset parser** — JSON is the canonical
  authoring format; richer YAML flows are deferred.
- **Per-workspace persistence, not a global data dir** — a workflow is
  reachable only from the workspace that started it; cross-workspace
  restore and spill-based large outputs are deferred.
