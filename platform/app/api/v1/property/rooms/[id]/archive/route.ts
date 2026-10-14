import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { archiveRoom, input as archiveInput } from '@/server/commands/property/archiveRoom'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** What would stop this room being archived (AT-029). Read-only. ?cascade=1 treats active beds as "archived together". */
export const GET = route({
  name: 'property.room.archive_check',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  handler: async (rc, _b, req, _r, { params }) => {
    const id = idParam(params)
    return id ? previewArchive(rc.actor, 'room', id, new URL(req.url).searchParams.get('cascade') === '1') : fail.notFound()
  },
})

/** Archive only, never delete. Refused with the dependencies listed while the room is occupied, reserved or has active beds. */
export const POST = route({
  name: 'property.room.archive',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  body: archiveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? archiveRoom(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
