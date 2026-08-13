import { describe, expect, it } from 'vitest'
import { attachBoard, decideAcross, queryBoards, type DecideOutcome, type GatedflowBoard } from '../src/transport.js'

function board(workflowId: string, gate = false): GatedflowBoard {
  return {
    snapshot: () => ({
      gates: gate ? [{ workflow_id: workflowId, step: 's1', checkpoint_type: 'user_confirm', header: 'gatedflow gate', message: 'go?' }] : [],
      workflows: [{ workflow_id: workflowId, status: gate ? 'paused' : 'completed', current_step: gate ? 's1' : 'done', error: null }],
    }),
    decide: async (id, decision, reason, source): Promise<DecideOutcome> => {
      if (id !== workflowId) return { ok: false, error: 'unknown workflow' }
      return { ok: true, workflow_id: id, status: 'running', current_step: 's1' }
    },
  }
}

describe('transport hub', () => {
  it('aggregates gates and workflows across every attached board', () => {
    const detachA = attachBoard(board('wf-a', true))
    const detachB = attachBoard(board('wf-b'))
    const snapshot = queryBoards()
    expect(snapshot.gates).toHaveLength(1)
    expect(snapshot.gates[0]!.workflow_id).toBe('wf-a')
    expect(snapshot.workflows.map((w) => w.workflow_id)).toEqual(['wf-a', 'wf-b'])
    detachA()
    detachB()
    expect(queryBoards().workflows).toEqual([])
  })

  it('routes a decision to the board that owns the workflow', async () => {
    const detachA = attachBoard(board('wf-a'))
    const detachB = attachBoard(board('wf-b'))
    const outcome = await decideAcross('wf-b', 'approve', undefined)
    expect(outcome).toMatchObject({ ok: true, workflow_id: 'wf-b', status: 'running' })
    detachA()
    detachB()
  })

  it('answers unknown workflow when no board owns the id', async () => {
    const detach = attachBoard(board('wf-a'))
    const outcome = await decideAcross('wf-zzz', 'reject', 'nope')
    expect(outcome).toEqual({ ok: false, error: 'unknown workflow' })
    detach()
  })

  it('the first board that claims an id wins (generation overlap)', async () => {
    const detachA = attachBoard(board('wf-shared'))
    const detachB = attachBoard(board('wf-shared'))
    await expect(decideAcross('wf-shared', 'approve', undefined)).resolves.toMatchObject({ ok: true })
    detachA()
    detachB()
  })
})
