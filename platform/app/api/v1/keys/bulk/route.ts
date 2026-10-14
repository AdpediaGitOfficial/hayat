import { route } from '@/server/http'
import { bulkCreateItems, bulkInput } from '@/server/commands/keys/registry'

export const dynamic = 'force-dynamic'

/** Adds many items at once (a prefix and a count, or a list of codes); each code succeeds or fails on its own. */
export const POST = route({
  name: 'keys.bulk_create',
  access: { kind: 'action', action: 'keys.manage' },
  body: bulkInput,
  handler: (rc, body) => bulkCreateItems(rc, body),
})
