import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { getUserDetail } from '@/server/queries/access/users'
import { pathId } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'access.users.detail',
  access: { kind: 'action', action: 'users_roles.view' },
  handler: async (rc, _b, _req, _reply, { params }) => {
    const id = pathId(params)
    const detail = id ? await getUserDetail(rc.actor, id, rc.clock.now(), rc.user.id) : undefined
    return detail ? ok(detail) : fail.notFound()
  },
})
