import { route } from '@/server/http'
import { fail, ok } from '@/server/command/result'
import { createInput, createItem } from '@/server/commands/keys/registry'
import { canUseKeys, listItems } from '@/server/queries/keys/items'
import type { HandoverStatus } from '@/server/db/schema.stage3'

export const dynamic = 'force-dynamic'

const STATUSES = ['in_cabinet', 'issued', 'lost', 'damaged', 'retired', 'outstanding']

/**
 * Keys and assets the actor may see. The guard is "any signed-in user" because several policy actions can read them (view,
 * manage, issue and return, night keys): the query narrows the rows in SQL to the actor's sites, or to what they hold (a Resident).
 */
export const GET = route({
  name: 'keys.list',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    if (!canUseKeys(rc.actor)) return fail.forbidden('see keys and assets')
    const u = new URL(req.url).searchParams
    const num = (k: string) => (u.has(k) && u.get(k) !== '' ? Number(u.get(k)) : undefined)
    const status = u.get('status') ?? undefined
    const category = u.get('category')
    return ok(await listItems(rc.actor, {
      siteId: u.get('siteId') ?? undefined, status: status && STATUSES.includes(status) ? (status as HandoverStatus | 'outstanding') : undefined,
      staffId: u.get('staffId') ?? undefined, bedId: u.get('bedId') ?? undefined, roomId: u.get('roomId') ?? undefined,
      category: category === 'key' || category === 'asset' ? category : undefined, code: u.get('code') ?? undefined, q: u.get('q') ?? undefined,
      overdue: u.get('overdue') === 'true' ? true : undefined, afterHours: u.get('afterHours') === 'true' ? true : undefined, includeArchived: u.get('includeArchived') === 'true', limit: num('limit'), offset: num('offset'),
    }))
  },
})

/** Adds one key or asset to a site's cabinet (Super Admin, Accommodation Admin). */
export const POST = route({
  name: 'keys.create',
  access: { kind: 'action', action: 'keys.manage' },
  body: createInput,
  handler: (rc, body) => createItem(rc, body),
})
