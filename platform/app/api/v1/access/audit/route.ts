import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { searchAudit } from '@/server/queries/access/audit'
import { auditQuery, queryOf, toAuditFilter } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/**
 * The audit log, read-only and scoped (AT-028). This file deliberately exports GET and nothing else: no API route
 * can change or delete an audit row (tests/api/access/audit-immutable.test.ts scans every route file for that).
 */
export const GET = route({
  name: 'access.audit.search',
  access: { kind: 'action', action: 'audit_log.view' },
  handler: async (rc, _b, req) => {
    const q = auditQuery.safeParse(queryOf(req))
    if (!q.success) return fail.invalid('Some filters need attention', Object.fromEntries(q.error.issues.map(i => [i.path.join('.') || '_', i.message])))
    return ok(await searchAudit(rc.actor, toAuditFilter(q.data)))
  },
})
