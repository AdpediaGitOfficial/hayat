import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { renewEntry, input } from '@/server/commands/waitlist/renew'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Renew a waitlist entry (Accommodation Admin): revalidates eligibility, keeps the place only if the requirements are unchanged. */
export const POST = route({
  name: 'waitlist.renew',
  access: { kind: 'action', action: 'requests_waitlist.manage_waitlist' },
  body: input.omit({ entryId: true }),
  handler: (rc, body, _req, _r, { params }) => {
    const entryId = idParam(params)
    return entryId ? renewEntry(rc, { ...body, entryId }) : Promise.resolve(fail.notFound())
  },
})
