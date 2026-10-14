import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { approveEmergency, approveInput } from '@/server/commands/emergency/decide'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Approve a provisional stay: it becomes Active. Never the person who started it (D-26, AT-017). */
export const POST = route({
  name: 'emergency.approve',
  access: { kind: 'action', action: 'emergency_checkin.approve' },
  body: approveInput.omit({ caseId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const caseId = idParam(params)
    return caseId ? approveEmergency(rc, { ...body, caseId }) : Promise.resolve(fail.notFound())
  },
})
