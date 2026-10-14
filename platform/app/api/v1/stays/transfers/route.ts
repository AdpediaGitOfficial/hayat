import { route } from '@/server/http'
import { ok } from '@/server/command/result'
import { listTransfers } from '@/server/queries/stays/transfers'

export const dynamic = 'force-dynamic'

export const GET = route({
  name: 'stays.transfer.list',
  access: { kind: 'action', action: 'transfers_swaps.view' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url).searchParams
    return ok(await listTransfers(rc.actor, { status: u.get('status') ?? undefined, siteId: u.get('siteId') ?? undefined }))
  },
})
