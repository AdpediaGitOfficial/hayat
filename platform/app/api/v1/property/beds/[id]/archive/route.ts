import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { archiveBed, input as archiveInput } from '@/server/commands/property/archiveBed'
import { previewArchive } from '@/server/queries/property/archivePreview'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** What would stop this bed being archived (AT-029). Read-only. */
export const GET = route({
  name: 'property.bed.archive_check',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  handler: async (rc, _b, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? previewArchive(rc.actor, 'bed', id) : fail.notFound()
  },
})

/** Archive only, never delete. Refused with the dependencies listed while the bed is occupied, reserved or not yet ready. */
export const POST = route({
  name: 'property.bed.archive',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  body: archiveInput.omit({ id: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? archiveBed(rc, { ...body, id }) : Promise.resolve(fail.notFound())
  },
})
