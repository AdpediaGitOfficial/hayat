import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { reportOwnLost, reportOwnLostInput } from '@/server/commands/keys/ownLost'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/**
 * A resident reports a key or asset they hold as lost. PROPOSED (P-05), pending client sign-off: refused with a clear reason unless the
 * setting `keys.resident_may_report_lost` is on. It can only ever record "lost", never "returned" or "found".
 */
export const POST = route({
  name: 'keys.report_own_lost',
  access: { kind: 'action', action: 'keys.report_own_lost' },
  body: reportOwnLostInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? reportOwnLost(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
