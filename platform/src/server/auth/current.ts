import { eq } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { staffProfile } from '@/server/db/schema'
import type { Clock } from '@/server/clock'
import type { Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { fail, type Failure } from '@/server/command/result'
import { availableModes, buildActor, chooseMode, loadAccess, type Access } from './actor'
import { resolveSession } from './session'

export interface CurrentUser {
  rc: RequestContext
  mustChangePassword: boolean
  modes: Role[]
  access: Access
  displayName: string
}

/**
 * The one place a session token becomes an acting identity. Used by API routes and by server-rendered pages,
 * so both enforce exactly the same expiry, revocation and mode rules.
 */
export async function currentUser(token: string | undefined, a: { clock: Clock; requestId: string; ip?: string }): Promise<CurrentUser | Failure> {
  const db = getDb()
  const now = a.clock.now()
  const r = await resolveSession(db, token, now)
  if (!r.ok) return fail.unauthenticated()
  const access = await loadAccess(db, r.user.id, now)
  const role = chooseMode(access, r.session.activeRole)
  if (!role) return fail.forbidden('use the system because no role is assigned', 'Administrator')
  const actor = buildActor(access, role, r.user.staffId ?? undefined)
  const [staff] = r.user.staffId ? await db.select({ name: staffProfile.fullName }).from(staffProfile).where(eq(staffProfile.id, r.user.staffId)) : []
  return {
    rc: { actor, user: { id: r.user.id, username: r.user.username, staffId: r.user.staffId ?? undefined }, sessionId: r.session.id, requestId: a.requestId, ip: a.ip, clock: a.clock },
    mustChangePassword: r.user.mustChangePassword,
    modes: availableModes(access),
    access,
    displayName: staff?.name ?? r.user.username,
  }
}
