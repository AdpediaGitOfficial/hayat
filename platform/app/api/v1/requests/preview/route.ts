import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { fail, ok } from '@/server/command/result'
import { isUuid } from '@/server/commands/property/shared'
import { requestPreview } from '@/server/queries/requests/preview'

export const dynamic = 'force-dynamic'
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Before filing: eligibility problems in plain words and how many beds look free. Counts only, nothing about other people. */
export const GET = route({
  name: 'requests.preview',
  access: { kind: 'action', action: 'requests_waitlist.submit' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    const siteId = u.get('siteId') ?? '', from = u.get('from') ?? '', to = u.get('to') ?? '', staffId = u.get('staffId') ?? '', employeeId = (u.get('employeeId') ?? '').slice(0, 40)
    if (!isUuid(siteId) || !DATE.test(from) || (to && !DATE.test(to)) || (staffId && !isUuid(staffId))) return fail.invalid('Choose a site and an arrival date', { siteId: 'Required', from: 'Required' })
    if (to && to <= from) return fail.invalid('The departure day must be after the arrival day', { to: 'After the arrival day' })
    const p = await requestPreview(getDb(), rc.actor, { staffId: staffId || undefined, employeeId: employeeId || undefined, siteId, from, to: to || undefined, now: rc.clock.now() })
    return p ? ok(p) : fail.notFound()
  },
})
