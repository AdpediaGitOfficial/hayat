import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { blockBed, input as blockInput } from '@/server/commands/property/blockBed'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Block a bed with a reason and an optional last blocked day. The answer lists the reservations still on the bed. */
export const POST = route({
  name: 'property.bed.block',
  access: { kind: 'action', action: 'rooms_beds.block' },
  body: blockInput.omit({ bedId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const bedId = idParam(params)
    return bedId ? blockBed(rc, { ...body, bedId }) : Promise.resolve(fail.notFound())
  },
})
