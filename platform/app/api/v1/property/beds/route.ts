import { route } from '@/server/http'
import { createBed, input as createInput } from '@/server/commands/property/createBed'

export const dynamic = 'force-dynamic'

export const POST = route({
  name: 'property.bed.create',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  body: createInput,
  handler: (rc, body) => createBed(rc, body),
})
