/**
 * Process-level gate-panel hub shared by the two composition rows.
 *
 * The per-preset engine row (`@gatedflow/dsh/host`) attaches a board per
 * mounted instance and detaches it on disposal; the host-composition gateway
 * row (`@gatedflow/dsh/gateway`) owns the HTTP routes and reads every board.
 *
 * A plain module singleton, not a Cordis service: both halves are the same
 * package resolved to the same module instances, and publishing a service
 * would drag the preset row into the root realm. Standing generations of a
 * preset coexist until process exit by design, so the hub must aggregate
 * boards instead of assuming one.
 */

export interface GateRecord {
  workflow_id: string
  step: string
  checkpoint_type: string
  header: string
  message: string
}

export interface WorkflowRecord {
  workflow_id: string
  status: string
  current_step: string
  error: string | null
}

export interface BoardSnapshot {
  gates: GateRecord[]
  workflows: WorkflowRecord[]
}

export interface DecideOutcome {
  ok: boolean
  workflow_id?: string
  status?: string
  current_step?: string
  error?: string
}

/**
 * One mounted engine instance's view of its workflows. The gateway never
 * touches runtimes directly — it only asks boards.
 */
export interface GatedflowBoard {
  snapshot(): BoardSnapshot
  decide(workflowId: string, decision: 'approve' | 'reject', reason: string | undefined, source: string): Promise<DecideOutcome>
}

const boards = new Set<GatedflowBoard>()

/** Register one board; the returned disposer removes it. */
export function attachBoard(board: GatedflowBoard): () => void {
  boards.add(board)
  return () => {
    boards.delete(board)
  }
}

/** Merge every live board into one panel payload. */
export function queryBoards(): BoardSnapshot {
  const gates: GateRecord[] = []
  const workflows: WorkflowRecord[] = []
  for (const board of boards) {
    const snapshot = board.snapshot()
    gates.push(...snapshot.gates)
    workflows.push(...snapshot.workflows)
  }
  return { gates, workflows }
}

/**
 * Route one panel decision to the board that owns the workflow. Boards
 * answer `unknown workflow` when the id is not theirs; the first board that
 * claims the id wins (generations are separated by process restarts, so a
 * double-claim only happens transiently after a preset edit).
 */
export async function decideAcross(workflowId: string, decision: 'approve' | 'reject', reason: string | undefined): Promise<DecideOutcome> {
  for (const board of boards) {
    const outcome = await board.decide(workflowId, decision, reason, 'panel')
    if (outcome.ok || outcome.error !== 'unknown workflow') return outcome
  }
  return { ok: false, error: 'unknown workflow' }
}
