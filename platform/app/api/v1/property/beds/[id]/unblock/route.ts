import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { unblockBed, input as unblockInput } from '@/server/commands/property/unblockBed'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Lift a block. The bed goes to Needs Cleaning, never straight to Available (D-64). */
export const POST = route({
  name: 'property.bed.unblock',
  access: { kind: 'action', action: 'rooms_beds.block' },
  body: unblockInput.omit({ bedId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const bedId = idParam(params)
    return bedId ? unblockBed(rc, { ...body, bedId }) : Promise.resolve(fail.notFound())
  },
})
