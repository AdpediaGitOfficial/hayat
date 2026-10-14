import { route } from '@/server/http'
import { fail } from '@/server/command/result'
import { closeCase } from '@/server/commands/exit/close'
import { z } from 'zod'
import { idParam } from '@/server/queries/property/respond'

export const dynamic = 'force-dynamic'

/** Close a clearance case. Refused while a mandatory item is Open or Outstanding (each listed with owner and next action). */
export const POST = route({
  name: 'exit.close_case',
  access: { kind: 'action', action: 'exit_clearance.manage_case' },
  body: z.object({}),
  handler: (rc, _body, _req, _r, { params }) => {
    const id = idParam(params)
    return id ? closeCase(rc, { caseId: id }) : Promise.resolve(fail.notFound())
  },
})
