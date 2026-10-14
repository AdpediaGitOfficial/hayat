import { route } from '@/server/http'
import { reactivateStaff, rehireInput } from '@/server/commands/exit/rehire'

export const dynamic = 'force-dynamic'

/** Rehire (D-41, AT-032): reactivates the existing profile. Blocked while an old clearance case is open (unless resolved) or a stay is not checked out. */
export const POST = route({
  name: 'exit.rehire',
  access: { kind: 'action', action: 'staff_directory.manage' },
  body: rehireInput,
  handler: (rc, body) => reactivateStaff(rc, body),
})
