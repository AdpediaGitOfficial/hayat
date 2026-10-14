import { z } from 'zod'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import { fail, ok, type Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { ROLES, SCOPE_KINDS } from '@/domain/enums'
import { loadTarget } from './guards'
import { fileRoleChange } from './role-change-core'

const reason = z.string().trim().min(1, 'Say why').max(500)
/** What the route takes in the body; the user comes from the path. */
export const body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add'), reason,
    role: z.enum(ROLES), scopeKind: z.enum(SCOPE_KINDS), siteId: z.uuid().optional(), buildingId: z.uuid().optional(),
  }),
  z.object({ kind: z.literal('remove'), reason, assignmentId: z.uuid() }),
])
export type Input = z.infer<typeof body> & { userId: string }
export interface Output { requestId: string; warnings: string[] }

/**
 * Maker step (D-27). Files the request; nothing changes for the user until a DIFFERENT Super Admin approves it.
 * Scope is only ever set by a Super Admin (D-22).
 */
export async function requestRoleChange(rc: RequestContext, raw: Input): Promise<Result<Output>> {
  return runCommand(rc, async c => {
    const denied = authorize(c, 'users_roles.manage_roles_and_scope')
    if (denied) return denied
    const target = await loadTarget(c.tx, raw.userId, { lock: true })
    if (!target) return fail.notFound()
    const filed = raw.kind === 'add'
      ? await fileRoleChange(c, target, { kind: 'add', spec: { role: raw.role, scopeKind: raw.scopeKind, siteId: raw.siteId, buildingId: raw.buildingId }, reason: raw.reason })
      : await fileRoleChange(c, target, { kind: 'remove', assignmentId: raw.assignmentId, reason: raw.reason })
    if ('ok' in filed) return filed
    return ok({ requestId: filed.id, warnings: filed.warnings }, 'Sent for approval. A different Super Admin must approve it before anything changes')
  })
}
