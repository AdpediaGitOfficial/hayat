import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { REQUEST_STATUSES, type RequestStatus } from '@/domain/enums'
import { isUuid } from '@/server/commands/property/shared'
import { input as submitInput, submitRequest } from '@/server/commands/requests/submit'
import { listRequests } from '@/server/queries/requests/list'

export const dynamic = 'force-dynamic'

/** Requests the actor may see (site for staff roles, own for a Resident). Filters: status (or "open"), siteId, q, limit, offset. */
export const GET = route({
  name: 'requests.list',
  access: { kind: 'action', action: 'requests_waitlist.view' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const status = u.get('status') ?? ''
    if (status && status !== 'open' && !(REQUEST_STATUSES as readonly string[]).includes(status)) return fail.invalid('Unknown status', { status: 'Use open or a request status' })
    const siteId = u.get('siteId') ?? ''
    if (siteId && !isUuid(siteId)) return fail.invalid('Not a valid site', { siteId: 'Not a valid identifier' })
    const num = (k: string) => (u.get(k) ? Number(u.get(k)) : undefined)
    return ok(await listRequests(getDb(), rc.actor, { status: (status || undefined) as RequestStatus | 'open' | undefined, siteId: siteId || undefined, q: u.get('q') ?? undefined, limit: num('limit'), offset: num('offset') }, rc.clock.now()))
  },
})

/** File a request: a Resident for themselves, Reception and Accommodation Admins on behalf of staff at their own sites. */
export const POST = route({
  name: 'requests.submit',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  body: submitInput,
  handler: (rc, body) => submitRequest(rc, body),
})
