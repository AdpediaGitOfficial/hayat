import { auditEvent } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { getStaff } from '@/server/queries/staff/list'
import type { StaffShape } from '@/server/queries/staff/access'
import type { StaffRecord } from '@/server/queries/staff/shapes'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One staff record, as the acting role may see it. A refusal is always the same plain 404 (AT-001): it does not say whether
 * the person exists. When someone who may see only their own record asks for another person's, the attempt is written to the
 * audit log (`staff.view_denied`) with a small insert OUTSIDE any transaction, so it survives the refusal. The event holds
 * the id that was asked for and who asked, and no personal data.
 */
export async function viewStaff(rc: RequestContext, id: string): Promise<Result<{ shape: StaffShape; staff: StaffRecord }>> {
  if (!UUID.test(id)) return fail.notFound()
  const r = await getStaff(getDb(), rc.actor, id)
  switch (r.kind) {
    case 'found': return ok({ shape: r.shape, staff: r.staff })
    case 'no_access': return fail.forbidden('look up staff')
    case 'not_own':
      try {
        await getDb().insert(auditEvent).values({
          actorUserId: rc.user.id, actorRole: rc.actor.role, action: 'staff.view_denied', entityType: 'staff_profile', entityId: id,
          reason: 'Asked for a profile other than their own', requestId: rc.requestId, ip: rc.ip ?? null,
        })
      } catch (e) {
        // Never let the log decide the answer; the person still gets the plain 404.
        console.error(JSON.stringify({ level: 'error', msg: 'staff.view_denied audit failed', requestId: rc.requestId, error: e instanceof Error ? e.message : String(e) }))
      }
      return fail.notFound()
    default: return fail.notFound()
  }
}
