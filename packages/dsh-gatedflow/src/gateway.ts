/**
 * Host-composition gateway row: the gate-panel HTTP transport and the
 * browser half's host anchor. This module is the PACKAGE MAIN export, so
 * the host row uses the bare name `@gatedflow/dsh` — `dsh-client-modules`
 * resolves `${entryName}/package.json` for `dsh.client` discovery, and a
 * subpath entry name is never scanned.
 *
 * The `webServer` route registry is a composition-level contract — duplicate
 * `(kind, path)` registrations throw — and the browser half ships only for
 * packages the host Loader composes (`dsh.client` discovery). Both are
 * process-global, so they belong here, in the host composition, rather than
 * in the per-preset engine row, whose standing generations coexist until
 * process exit and would collide on a second registration.
 *
 * The preset row (`@gatedflow/dsh/host`) attaches its board through the
 * shared transport hub; this row owns the routes and serves every board.
 * Without this row the engine and tools still work — only the panel is
 * missing (gates are then followed through `gf_status` instead).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { decideAcross, queryBoards } from './transport.js'

export const name = '@gatedflow/dsh'
export const inject = ['webServer']

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 65536): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx: Context): void {
  const webServer = ctx.webServer

  const gatesRoute: WebRoute = {
    kind: 'exact',
    path: '/gatedflow/gates',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      json(res, 200, queryBoards())
    },
  }

  const decideRoute: WebRoute = {
    kind: 'exact',
    path: '/gatedflow/decide',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let payload: { workflowId?: string; decision?: 'approve' | 'reject'; reason?: string }
      try {
        payload = JSON.parse((await readBody(req)) || '{}') as typeof payload
      } catch {
        json(res, 400, { ok: false, error: 'invalid JSON body' })
        return
      }
      if (typeof payload.workflowId !== 'string' || payload.workflowId.length === 0) {
        json(res, 400, { ok: false, error: 'workflowId is required' })
        return
      }
      const decision = payload.decision === 'approve' ? 'approve' : payload.decision === 'reject' ? 'reject' : undefined
      if (decision === undefined) {
        json(res, 400, { ok: false, error: 'decision must be approve or reject' })
        return
      }
      json(res, 200, await decideAcross(payload.workflowId, decision, payload.reason))
    },
  }

  ctx.effect(() => {
    const disposeGates = webServer.register(gatesRoute)
    const disposeDecide = webServer.register(decideRoute)
    return () => {
      disposeGates()
      disposeDecide()
    }
  })
}
