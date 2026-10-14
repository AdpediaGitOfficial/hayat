import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { createAccount, input as createInput } from '@/server/commands/access/create-account'
import { listUsers } from '@/server/queries/access/users'
import { queryOf, toUserFilter, userListQuery } from '@/server/queries/access/params'

export const dynamic = 'force-dynamic'

/** Accounts the caller may see (Super Admin: all; Accommodation Admin and Auditor: those sharing one of their sites). */
export const GET = route({
  name: 'access.users.list',
  access: { kind: 'action', action: 'users_roles.view' },
  handler: async (rc, _b, req) => {
    const q = userListQuery.safeParse(queryOf(req))
    if (!q.success) return fail.invalid('Some filters need attention', Object.fromEntries(q.error.issues.map(i => [i.path.join('.') || '_', i.message])))
    return ok(await listUsers(rc.actor, toUserFilter(q.data), rc.clock.now(), rc.user.id))
  },
})

/** Creates an account for an existing staff profile and returns the temporary password ONCE. */
export const POST = route({
  name: 'access.users.create',
  access: { kind: 'action', action: 'users_roles.manage_staff_accounts' },
  body: createInput,
  handler: (rc, body) => createAccount(rc, body),
})
