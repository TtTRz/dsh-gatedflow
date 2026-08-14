# dsh-gatedflow

Gated, durable, **human-in-the-loop workflows for DeepSeek Harness** — gates
as control flow: "must verify / confirm / review" rules live in the engine,
not in prompts, so no agent can skip them under load.

> **Zero-mutation replan · gates as control flow · declarative subflows.**
> The engine core contains no LLM and no orchestrator dependencies.

## Packages

| Package | Description | Dependencies |
|---|---|---|
| [`@gatedflow/engine`](packages/engine) | Framework-agnostic engine core: validation, expansion, deterministic conditions, the workflow state machine. | none |
| [`@gatedflow/dsh`](packages/dsh-gatedflow) | DeepSeek Harness adapter: `gf_*` tools, the gate panel UI, the anti-bypass guard, filesystem persistence. | `@gatedflow/engine` + DSH services |

## The idea in one picture

```
user task ──► agent composes atomics (Ref/Inline) ──► gf_start
                                                       │
              path ① single Ref ──────────────┐        │
              path ② multi/inline ── pre_start_gate (human approves the plan)
                                                       ▼
              shell (command + expect) ─ interrupt (human gate via panel)
              handoff (delegate back to the agent) ─ conditional (structured fields)
                                                       ▼
                                                   done (auto)
```

- **Gates are control flow.** `interrupt` steps pause the engine; the human
  approves or rejects through a panel card in the conversation. The model
  agent has **no approve/reject channel** — `gf_advance` rejects them (guard
  + schema), and decisions travel straight from the panel to the engine.
- **Zero mutation.** Agents cannot rewrite workflow state, params, or
  routing. Failures take exactly two paths: step-level failure with
  `pause_on_failure` → pause → human repairs → `retry` (prior outputs kept);
  otherwise `abort` → failed → human reviews → new workflow.
- **Declarative subflows.** Workflows are JSON/YAML data, validated at load
  time and snapshotted at start — what the human approves is exactly what
  executes.
- **No LLM in the engine.** Semantic judgment happens on the agent side and
  returns *structured fields*; the engine only evaluates deterministic
  operators (`==`, `!=`, `>=`, `<=`, `>`, `<`, `contains`, `&&`, `||`, `!`).

## Quick start

```bash
npm install
npm run check   # build + typecheck + unit tests
```

### Run a workflow (as a DSH user)

The adapter registers seven tools. The agent composes a plan, then:

```
gf_start({ atomics: [
  { name: 'gf-verify-demo', params: { note: 'hello' } },
  { type: 'shell', params: { command: 'echo done', expect: 'true' } },
]})
```

- **Single Ref** runs the preset deterministically (no gate wrapper).
- **Multiple / Inline atomics** wrap a `pre_start_gate`: the engine pauses
  and the plan appears as a panel card above the composer. Click **✓ Approve**
  to proceed or **✕ Reject** to abort.
- Handoff gates pause for the agent; the agent returns structured results
  via `gf_advance(handoff_complete, result)`.
- A failed step with `pause_on_failure` shows an **Awaiting retry** card;
  after the human repairs the environment,
  `gf_advance(decision: 'retry')` re-runs only that step.

### Author a subflow

Drop a JSON file into a subflows directory — the session workspace's
`.gatedflow/subflows` (scanned automatically, takes precedence on name
conflicts) or the shared root (`~/.gatedflow/subflows` by default,
`GATEDFLOW_SUBFLOWS_DIR` to override) — then call `gf_reload_subflows`
(hot-loaded, no restart):

```json
{
  "name": "release",
  "description": "build with objective verification, human review, then publish",
  "keywords": ["release", "build", "review"],
  "params": { "branch": { "required": true } },
  "steps": [
    { "id": "build", "type": "shell", "params": { "command": "npm run build", "expect": "test -f dist/index.js", "max_retries": 1, "pause_on_failure": true }, "on_success": "review", "on_failure": "abort" },
    { "id": "review", "type": "interrupt", "params": { "message": "Publish ${branch}?" }, "on_approve": "publish", "on_reject": "abort" },
    { "id": "publish", "type": "shell", "params": { "command": "npm publish" }, "on_success": "next", "on_failure": "abort" }
  ]
}
```

See [`examples/subflows/`](examples/subflows) for more.

## Architecture

- [`docs/DESIGN.md`](docs/DESIGN.md) — root constraints, step model, routing,
  data references, gate protocol, persistence and anti-stuck design, with
  the decision record.
- [`docs/INTEGRATION.md`](docs/INTEGRATION.md) — mounting the adapter in a
  DSH composition, environment variables, tool reference, and the agent
  skill guidance.

## Development

```bash
npm install
npm run test          # unit tests (vitest, engine + adapter)
npm run typecheck     # strict TS across both packages
npm run build         # tsc output for engine + dsh
```

The engine package is deliberately dependency-free and framework-agnostic;
the DSH adapter is a thin, typed wiring layer over the harness services
(`fs`, `shell`, `tools`, `timer`, `subagents`; the gateway row additionally
consumes `webServer`), configurable through a
schemastery `Config` schema exactly like the official DSH plugins. See the
[package README](packages/dsh-gatedflow/README.md) for the plugin contract.
Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

v0.1 ships the engine core plus the DSH adapter with `shell` / `interrupt` /
`handoff` / `conditional` / `agent_delegate` / `agent_resume` steps, the
gate panel, the anti-bypass guard, gate deadlines, /stop-safe interruption
semantics, hot-reloadable subflows, bounded-tail audit logs, and
restore-on-reference persistence. Roadmap: YAML-native subflow authoring
improvements and a solidify flow that turns recurring dynamic plans into
named presets.

## License

MIT — see [LICENSE](LICENSE).

## Relationship to gatedflow

This project is an independent, native implementation of the gatedflow
philosophy for DeepSeek Harness. It shares the vocabulary (atomics,
subflows, pre_start_gate, zero-mutation replan, decision records) but
re-implements everything on harness-native primitives — the engine core is
written from scratch in TypeScript with no external dependencies.
