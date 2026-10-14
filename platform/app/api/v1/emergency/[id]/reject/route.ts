import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { rejectEmergency, rejectInput } from '@/server/commands/emergency/decide'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Reject with a reason: the stay goes to Resolution pending, a relocation task opens for the Accommodation Admin, nobody is moved (D-69, AT-018). */
export const POST = route({
  name: 'emergency.reject',
  access: { kind: 'action', action: 'emergency_checkin.approve' },
  body: rejectInput.omit({ caseId: true }),
  reauth: { action: 'emergency.decide' },
  handler: (rc, body, _req, _r, { params }) => {
    const caseId = idParam(params)
    return caseId ? rejectEmergency(rc, { ...body, caseId }) : Promise.resolve(fail.notFound())
  },
})
