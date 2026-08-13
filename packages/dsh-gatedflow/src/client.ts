/**
 * DeepSeek Harness client half: the gate panel.
 *
 * Registers a card strip in the composer dock (`conversation.input.dock`)
 * that polls the host's `/gatedflow/gates` endpoint and renders pending
 * gates with approve/reject buttons. Decisions POST to `/gatedflow/decide`,
 * so human decisions travel directly to the engine — the model agent has
 * no approve/reject channel at all.
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

interface GateView {
  workflow_id: string
  step: string
  checkpoint_type: 'user_confirm' | 'handoff' | 'retry'
  header: string
  message: string
}

interface WorkflowView {
  workflow_id: string
  status: string
  current_step: string
  error: string | null
}

interface GatesSnapshot {
  gates: GateView[]
  workflows: WorkflowView[]
}

interface SlotsLike {
  inject: (slot: string, callback: () => void) => void
  register: (options: { name: string; id: string; order: number; label: string }, render: () => React.ReactElement | null) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots?: SlotsLike
  }
}

const DEFAULT_POLL_INTERVAL_MS = 2000

export const name = '@gatedflow/dsh'
export const inject = ['slots']

/** Plugin config. All optional — `Config` supplies the defaults. */
export interface Config {
  /** Gate-panel polling interval in milliseconds. */
  panelPollIntervalMs?: number
}

export const Config = z.object({
  panelPollIntervalMs: z.number().default(DEFAULT_POLL_INTERVAL_MS),
})

export function apply(ctx: Context, config?: Config): void {
  const slots = ctx.slots
  if (slots === undefined) return

  const pollIntervalMs = config?.panelPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const disposeStyle = stylesInsert(css)
  ctx.effect(() => disposeStyle)

  const poll = (callback: () => void, delay: number) => {
    const id = window.setInterval(callback, delay)
    return () => window.clearInterval(id)
  }

  slots.inject('conversation.input.dock', () => {
    slots.register(
      { name: 'conversation.input.dock', id: 'gatedflow-gates', order: 30, label: 'gatedflow gates' },
      () => React.createElement(GateDock, { poll, pollIntervalMs }),
    )
  })
}

function stylesInsert(cssText: string): () => void {
  const style = document.createElement('style')
  style.textContent = cssText
  document.head.appendChild(style)
  return () => style.remove()
}

function GateDock({ poll, pollIntervalMs }: { poll: (callback: () => void, delay: number) => () => void; pollIntervalMs: number }): React.ReactElement | null {
  const [snap, setSnap] = React.useState<GatesSnapshot | null>(null)
  const [busy, setBusy] = React.useState<{ wid: string; decision: 'approve' | 'reject' } | null>(null)

  React.useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch('/gatedflow/gates', { cache: 'no-store' })
        if (response.ok && alive) setSnap((await response.json()) as GatesSnapshot)
      } catch {
        // Host route not mounted yet; keep polling.
      }
    }
    void tick()
    const disposer = poll(tick, pollIntervalMs)
    return () => {
      alive = false
      disposer()
    }
  }, [poll, pollIntervalMs])

  if (snap === null) return null
  const gates = snap.gates
  const active = snap.workflows.filter((w) => w.status === 'paused' || w.status === 'running')
  if (gates.length === 0 && active.length === 0) return null

  const decide = async (wid: string, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy({ wid, decision })
    try {
      await fetch('/gatedflow/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: wid, decision, reason: '' }),
      })
    } catch {
      // Keep the previous snapshot; the next poll reconciles.
    }
    setBusy(null)
  }

  return React.createElement(
    'div',
    { className: 'gf-dock' },
    ...gates.map((gate) => {
      const isConfirm = gate.checkpoint_type === 'user_confirm'
      const isBusyApprove = busy?.wid === gate.workflow_id && busy.decision === 'approve'
      const isBusyReject = busy?.wid === gate.workflow_id && busy.decision === 'reject'
      return React.createElement(
        'div',
        { key: gate.workflow_id, className: 'gf-card' },
        React.createElement(
          'div',
          { className: 'gf-head' },
          React.createElement('span', { className: isConfirm ? 'gf-badge' : 'gf-badge gf-handoff' }, isConfirm ? 'Pending' : gate.checkpoint_type === 'retry' ? 'Awaiting retry' : 'Handoff'),
          React.createElement('span', { className: 'gf-title' }, gate.header),
          React.createElement('span', { className: 'gf-wid' }, gate.workflow_id),
        ),
        React.createElement('div', { className: 'gf-msg' }, gate.message),
        isConfirm
          ? React.createElement(
              'div',
              { className: 'gf-actions' },
              React.createElement('button', { className: 'gf-btn gf-approve', disabled: busy !== null, onClick: () => void decide(gate.workflow_id, 'approve') }, isBusyApprove ? 'Working…' : '✓ Approve'),
              React.createElement('button', { className: 'gf-btn gf-reject', disabled: busy !== null, onClick: () => void decide(gate.workflow_id, 'reject') }, isBusyReject ? 'Working…' : '✕ Reject'),
            )
          : React.createElement('div', { className: 'gf-note' }, gate.checkpoint_type === 'retry' ? 'Awaiting repair; the agent resumes afterwards.' : 'Handed to the agent; it advances automatically when done.'),
      )
    }),
    active.length > 0
      ? React.createElement(
          'div',
          { className: 'gf-status' },
          ...active.map((w) =>
            React.createElement('span', { key: w.workflow_id }, `${w.workflow_id} · ${w.status}${w.current_step ? ` @ ${w.current_step}` : ''}${w.error ? ` · ${w.error}` : ''}`),
          ),
        )
      : null,
  )
}

const css = `
.gf-dock { display:flex; flex-direction:column; gap:8px; margin:0 0 6px; }
.gf-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-left:3px solid var(--dsw-alias-state-warn-primary); border-radius:10px; padding:10px 14px; }
.gf-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.gf-badge { font-size:11px; font-weight:600; color:#ffffff; background:var(--dsw-alias-state-warn-primary); border-radius:999px; padding:2px 9px; flex:none; }
.gf-badge.gf-handoff { background:var(--dsw-alias-brand-primary); }
.gf-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gf-wid { font-size:11px; color:var(--dsw-alias-label-secondary); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; flex:none; }
.gf-msg { font-size:12.5px; line-height:1.6; color:var(--dsw-alias-label-primary); white-space:pre-wrap; word-break:break-word; max-height:150px; overflow-y:auto; margin:0 0 10px; background:var(--dsw-alias-bg-layer-2); border-radius:8px; padding:8px 10px; }
.gf-actions { display:flex; gap:8px; align-items:center; }
.gf-btn { border:none; border-radius:8px; padding:6px 18px; font-size:12.5px; font-weight:600; cursor:pointer; line-height:1.5; transition:filter .12s ease; }
.gf-btn:hover { filter:brightness(1.08); }
.gf-btn:disabled { opacity:.5; cursor:default; filter:none; }
.gf-approve { background:var(--dsw-alias-state-success-primary); color:#ffffff; }
.gf-reject { background:transparent; color:var(--dsw-alias-state-error-primary); border:1px solid var(--dsw-alias-state-error-primary); }
.gf-note { font-size:12px; color:var(--dsw-alias-label-secondary); }
.gf-status { font-size:11.5px; color:var(--dsw-alias-label-secondary); display:flex; gap:12px; flex-wrap:wrap; padding:0 2px; }
`
