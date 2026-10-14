import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { listExceptions } from '@/server/queries/requests/exceptions'

export const dynamic = 'force-dynamic'

/**
 * Every Policy Approver exception and every use of it. Policy Approvers (own sites), Super Admins and Auditors read it; the
 * guard is "signed in" because that set is not one policy action, and listExceptions() answers 403 to everybody else.
 */
export const GET = route({
  name: 'requests.exceptions',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const kind = u.get('kind')
    const r = await listExceptions(getDb(), rc.actor, { kind: kind === 'gender' || kind === 'grade' ? kind : undefined, limit: u.get('limit') ? Number(u.get('limit')) : undefined, offset: u.get('offset') ? Number(u.get('offset')) : undefined })
    return r ? ok(r) : fail.forbidden('read the exception report', 'A Policy Approver, Super Admin or Auditor')
  },
})
