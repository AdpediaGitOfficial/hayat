import { route } from '@/server/http'
import { createRoom, input as createInput } from '@/server/commands/property/createRoom'

export const dynamic = 'force-dynamic'

/** A room, optionally with its beds. Building, floor and unit are optional (a villa is Site -> Room -> Bed). */
export const POST = route({
  name: 'property.room.create',
  access: { kind: 'action', action: 'rooms_beds.manage' },
  body: createInput,
  handler: (rc, body) => createRoom(rc, body),
})
