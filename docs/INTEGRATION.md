# dsh-gatedflow Integration Guide (DeepSeek Harness)

How to mount `@gatedflow/dsh` in a DSH composition, and the agent-side
usage contract.

## 1. Mounting

### Agent preset (engine + tools)

The engine row is per-preset: tool registrations are per-session
contributions. Add one row to the preset's `agent.cordis.yml`:

```yaml
- id: gatedflow
  name: '@gatedflow/dsh/host'
  config:
    stateDir: ~/.gatedflow        # shared subflow root (read-only)
    gateDeadlineSecs: 1800        # default gate timeout
    shellTimeoutMs: 120000        # default shell step timeout
    auditTailLines: 500           # bounded audit tail
    subflowDirs: []               # extra subflow directories
    subagentProvider: spawn       # subagents provider for agent steps
```

Injected services: `fs`, `shell`, `tools`, `timer`, `subagents`. The row
publishes no service and registers no process-global routes — standing
preset generations coexist until process exit, so anything process-global
must live host-side.

### Host composition (panel transport + UI)

`webServer` routes are a composition-level contract (duplicate
`(kind, path)` registrations throw) and the browser half ships only for
packages the host Loader composes. Both are process-global, so the panel
lives in one host row — insert it in the Host composition
(`cordis.patch.yml` or a profile bundle):

```yaml
- insert:
    - id: gatedflow-gateway
      name: '@gatedflow/dsh'      # bare name REQUIRED — see below
```

The bare package name is not stylistic: `dsh-client-modules` discovers the
browser half through `${entryName}/package.json`, so a subpath entry name
(such as `@gatedflow/dsh/gateway`) is never scanned and the panel would
never ship. The gateway module is therefore the package main export.

The gateway row registers `GET /gatedflow/gates` and
`POST /gatedflow/decide` against the real `WebRoute` contract of
`@deepseek-ai/dsh-host-webserver` (`kind` / `path` / node:http handler),
and anchors the browser half through the package's `dsh.client`
declaration — no separate client row. The client half registers the gate
panel in `conversation.input.dock`, polls `GET /gatedflow/gates`, and
POSTs decisions to `/gatedflow/decide`. Preset and gateway meet through a
package-level transport hub, so one gateway serves every preset that
mounts the engine row.

Without the gateway row the engine and tools still work — only the panel
is missing (gates are then followed through `gf_status`).

## 2. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `GATEDFLOW_STATE_DIR` | `~/.gatedflow` | Shared subflow root (the `stateDir` config wins); workflow state and audit live per workspace under `<workspace_root>/.gatedflow` |
| `GATEDFLOW_SUBFLOWS_DIR` | — | Extra subflow directory (appended to the scan list) |

Scan order per reload: `stateDir` → config `subflowDirs` → `GATEDFLOW_SUBFLOWS_DIR` → the calling session's `<workspace_root>/.gatedflow/subflows`; later directories override earlier ones on name conflicts (the workspace wins).

## 3. Tool reference

| Tool | Parameters | Semantics |
|---|---|---|
| `gf_start` | `atomics` (required), `workflow_id`, `workspace_root` | The only entry point; single Ref = deterministic, multiple/Inline = dynamic (wraps pre_start_gate) |
| `gf_advance` | `workflow_id` (required), `decision: retry\|handoff_complete\|handoff_fail`, `reason`, `result` | Advance a paused workflow; without a decision, resume after interruption |
| `gf_status` | `workflow_id` | Status summary (status/current_step/completed_steps/gate) |
| `gf_outputs` | `workflow_id`, `step_id?` | Read step outputs |
| `gf_kill` | `workflow_id`, `reason?` | Terminate (human-driven) |
| `gf_list_subflows` | — | List subflow metadata (name/description/keywords/params/exports) |
| `gf_reload_subflows` | — | Hot-reload the subflow directories |

**There are no approve/reject decisions** — human decisions on interrupt
gates go exclusively through the panel buttons (a guard blocks any
alternative).

## 4. Data-flow example (develop + publish)

1. The agent decomposes the task and first calls `gf_list_subflows` to
   match presets;
2. `gf_start(atomics=[{name:'release', params:{branch:'main'}}, {type:'shell',...}])`
   → the engine expands and wraps `pre_start_gate` → returns `paused`;
3. The panel shows the plan card → the user clicks **✓ Approve** → the
   engine runs build (expect verification);
4. The `review` interrupt → a second panel card → the user approves →
   publish → `done`;
5. Throughout, the agent only relays and reports — the decision power
   belongs to the human.

## 5. Agent guidance (skill suggestion)

Put the following into the workflow skill:

1. **Decompose before acting**: send the plan as a chat message and wait
   for confirmation before `gf_start`.
2. **Call `gf_list_subflows` before composing**: match intent with
   description/keywords; never hard-code the subflow list.
3. **Key shell steps carry `expect`**: objective verification lives in the
   step itself, not only in human review.
4. **Zero mutation**: no autonomous retry / parameter changes / skipping;
   failures follow the two paths in DESIGN §7.
5. **Gates are relay-only**: when a card appears, tell the user "a gate is
   awaiting approval in the panel"; never attempt approve/reject (there is
   no such channel).
6. **Handoff**: follow the `task_hint`, then `handoff_complete(result)`.
7. **Communication**: speak from the user's perspective ("what is being
   done"), never expose subflow names / step ids / scheduling mechanics.

## 6. Known boundaries (v0.1)

- **Agent steps run as continuable DSH subagents.** `agent_delegate`
  starts a background child (`ctx.subagents.startContinuable`) and waits
  for its initial turn through the `subagent/start` / `subagent/end`
  lifecycle pair; `agent_resume` follows the recorded child up and waits
  for the next turn. Resuming requires the same live parent session that
  delegated (a `followup` authority rule, not an engine one).
- **The panel needs the host-composed gateway row.** `webServer` routes and
  the browser half are process-global DSH registries; a preset that mounts
  only the engine row runs workflows without the panel.
- YAML support is a minimal-subset parser; JSON is the canonical authoring
  format.
