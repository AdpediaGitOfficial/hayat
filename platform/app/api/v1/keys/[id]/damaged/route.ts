import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { markDamaged, damagedInput } from '@/server/commands/keys/movements'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Records the item as damaged: note mandatory, evidence uploaded onto the item first. Never marked returned. */
export const POST = route({
  name: 'keys.damaged',
  access: { kind: 'authenticated' },
  body: damagedInput.omit({ itemId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? markDamaged(rc, { ...body, itemId: id }) : Promise.resolve(fail.notFound())
  },
})
