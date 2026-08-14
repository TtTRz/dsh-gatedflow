# dsh-gatedflow Design

This document is the design authority for dsh-gatedflow: root constraints,
the step model, routing, data references, the gate protocol, persistence,
and anti-stuck measures. Read the [README](../README.md) first for the
overview.

## 1. Root constraints (non-negotiable)

Every decision in gatedflow derives from three root constraints:

1. **The engine contains no LLM** — it is a pure control-flow engine.
   Semantic judgment happens on the agent side (spawn / handoff lets an LLM
   judge inside the agent and report *structured fields*); the engine only
   evaluates deterministic operators. This is the foundation of
   "gates cannot be bypassed".
2. **Pure declarative DSL** — a subflow is data, not code, and is not
   Turing-complete. It can be statically audited, hot-reloaded, and shipped
   as a data package.
3. **Zero-mutation replan** — agents may not rewrite workflow state (no
   autonomous retry, parameter changes, or step skipping). Failures take
   exactly two paths: a step-level failure with `pause_on_failure` → Paused
   → human repairs → `retry` (prior outputs kept); otherwise `abort` →
   Failed → human reviews → a new workflow.

## 2. Step model

Six user-writable step types (`done` is appended by the engine and never
exposed):

| type | purpose | outcomes |
|---|---|---|
| `shell` | bash command + optional `expect` verification (exit 0 required) + `max_retries` | on_success / on_failure |
| `interrupt` | human decision gate (panel approve/reject) | on_approve / on_reject |
| `handoff` | delegate a ReAct segment back to the orchestrating agent, return a result | on_success / on_failure |
| `conditional` | judge structured fields (deterministic operators, never NL semantics) | on_true / on_false |
| `agent_delegate` | start a continuable DSH subagent and watch its initial turn to completion (child id recorded as `{step.child_id}`) | on_success / on_failure |
| `agent_resume` | follow up the recorded child session with feedback and watch the next turn | on_success |

Verification is not a separate type: deterministic steps use `shell.expect`;
non-deterministic steps use "evaluation agent reports structured fields →
`conditional`" or an `interrupt` human review.

## 3. Routing

- Each outcome points to `next` / `done` / `abort` / a step id inside the
  same subflow.
- `next` is wired at expansion time to the following atomic block's entry,
  and to `done` for the last block.
- Step ids gain the subflow-name prefix at expansion (sanitized); duplicate
  Ref names gain an index suffix — ids never collide.

## 4. Data references

| Syntax | Timing | Source |
|---|---|---|
| `${param}` | build time | the current subflow's params |
| `{subflow.export}` | build time (rewritten by expansion) | a preceding subflow's exports (`{dev.session_name}` → `{dev_code.sn}`) |
| `{step.field}` | runtime | `step_outputs[step][field]` |

`$context.*` is a reserved namespace for adapters to inject workflow-level
context (future extension).

## 5. One entry point, two paths

`gf_start` takes `atomics` (an ordered spec list) plus optional
`workflow_id` (restore-on-reference, §8) and `workspace_root` (defaults to
the session workspace):

- **Path ① deterministic** — a single `Ref` runs the named preset; no gate
  wrapper (there is no ad-hoc plan to review).
- **Path ② dynamic** — multiple entries and/or `Inline` steps compose a
  plan; the engine wraps a `pre_start_gate` that pauses for human approval
  of the whole plan (including every command and expect) *before any real
  work starts*.

**Snapshot semantics** — expansion happens at start and persists with the
state. Editing a subflow file later never affects a running workflow:
**what the human approves is exactly what executes** (TOCTOU protection).

## 6. Gate protocol (panel protocol)

When an `interrupt` gate pauses:

1. The engine renders a gate card in the conversation dock panel (plan /
   message + ✓ Approve / ✕ Reject).
2. The user clicks → the panel POSTs `/gatedflow/decide` → the engine
   applies `decide(decision, reason, source='panel')` → routes by outcome
   and continues.
3. **The agent has no decision power**: the `gf_advance` schema only
   carries `retry / handoff_complete / handoff_fail`, and a tool guard
   blocks any approve/reject attempt.
4. The audit records `gate_decision` with `source: 'panel'` — human
   decisions are traceable.

`handoff` gates go through the agent: pause with a `task_hint`, the agent
does the work, then returns `handoff_complete(result)` or
`handoff_fail(reason)`.

## 7. Failure and interruption semantics

- **Step failure** — after `max_retries` exhausts: `pause_on_failure: true`
  → Paused (`pending: retry`) → human repairs → `advance('retry')` re-runs
  in place (`retry_counts` increments, prior `step_outputs` kept); otherwise
  `on_failure` (usually abort).
- **/stop or cancellation (interruption)** — an aborted shell step pauses,
  never fails; it is marked `interrupted` and `advance()` without a
  decision resumes the step in place. Interruption is human-driven and does
  not break zero-mutation.
- **Unrecoverable** — `abort` → Failed → human reviews (pull outputs with
  `gf_outputs`) → start a new workflow.

## 8. Anti-stuck measures

- **Gate deadlines** — a paused gate arms a deadline (`deadline_secs`,
  default 1800s); expiry fails the workflow and records `gate_timeout`.
  Every state transition clears the timer.
- **Startup reconcile** — persisted `running` workflows restore as
  `paused` (their process is gone); terminal states restore verbatim.
- **Lifecycle** — all timers, routes, and tool registrations belong to the
  Cordis fiber and are disposed with it.

## 9. Persistence and audit

- **State** — one JSON file per workflow (snapshot + expanded definition),
  atomically rewritten on every transition (`fs.writeText` unconditional
  overwrite).
- **Audit** — one JSONL per workflow, buffered and flushed in batches,
  keeping a bounded tail (500 lines by default). The DSH filesystem service
  has no append primitive, so the bounded rewrite keeps per-flush cost
  constant.
- Both live under the session workspace
  (`<workspace_root>/.gatedflow/workflows`, `<workspace_root>/.gatedflow/audit`)
  — writable under the sandbox's workspace-write policy by construction;
  `~/.gatedflow` only supplies the shared subflow scan root (read-only for
  the plugin).

## 10. Dependency-inversion seams (engine core)

```ts
interface EngineServices {
  registry: SubflowRegistry     // subflow registry
  shell: ShellRunner            // shell execution (DSH: bash executor)
  store: WorkflowStore          // state persistence
  timer: DeadlineTimer          // gate deadlines
  agent?: AgentExecutor         // agent step execution (optional)
  audit?: AuditSink             // audit events
  now?: () => number            // clock injection (tests)
  defaultGateDeadlineSecs?: number // default 1800
  defaultShellTimeoutMs?: number   // default 120000
}
```

The engine package has zero dependencies; any orchestrator implementing
these interfaces gets the full gating semantics.

## 11. Decision record (summary)

- **D-panel** — human gate decisions travel through the panel RPC, never
  through a model tool channel (DSH's question UI only renders inside an
  in-session tool call; a background engine ask has no visible carrier —
  the panel is the native answer).
- **D-interruption** — /stop interruption pauses, never fails (D6
  semantics).
- **D-snapshot** — expansion is snapshotted at start (TOCTOU protection).
- **D-audit** — bounded-tail JSONL (fs has no append; the shell-append path
  was rejected by the sandbox in practice).
- **D-duplicate-refs** — duplicate Ref names get index suffixes (aligned
  with the gatedflow duplicate-Ref fix).
- **D-serialization** — per-workflow state operations serialize through an
  op chain (concurrent advance / double-click protection).
- **D-validation** — structural validation at load plus re-validation at
  expansion (D15).
