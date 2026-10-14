import { z } from 'zod'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import { ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { revokeAllSessions } from '@/server/auth/session'
import { loadManagedAccount } from './guards'

export const input = z.object({ userId: z.uuid(), reason: z.string().trim().min(1, 'Say why').max(500) })
export type Input = z.infer<typeof input>
export const body = input.omit({ userId: true })
export interface Output { userId: string; sessionsEnded: number }

/** "Revoke all sessions": signs the person out everywhere, immediately. The account itself stays usable. */
export async function revokeUserSessions(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const t = await loadManagedAccount(c, raw.userId, 'end every session of')
    if ('ok' in t) return t
    const ended = await revokeAllSessions(c.tx, t.id, 'revoked_by_admin', c.now)
    await audit(c, {
      action: 'access.account.sessions_revoked', entityType: 'user_account', entityId: t.id, siteId: t.siteIds[0], reason: raw.reason,
      after: { sessionsEnded: ended },
    })
    return ok({ userId: t.id, sessionsEnded: ended }, ended === 1 ? '1 session ended' : `${ended} sessions ended`)
  })
}
