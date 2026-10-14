import { z } from 'zod'
import { route } from '@/server/http'
import { getDb } from '@/server/db/client'
import { attach, listAttachments } from '@/server/attachments'
import { ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

/** Attachments of one record: only if the actor may see the record. */
export const GET = route({
  name: 'attachments.list',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, req) => {
    const u = new URL(req.url)
    const entityType = u.searchParams.get('entityType') ?? ''
    const entityId = u.searchParams.get('entityId') ?? ''
    if (!/^[a-z_.]{1,40}$/.test(entityType) || !/^[0-9a-f-]{36}$/i.test(entityId)) return ok([])
    return ok(await listAttachments(getDb(), rc.actor, entityType, entityId))
  },
})

/** Uploads a PNG, JPEG or PDF (base64 in JSON) onto a record. What the bytes are is checked, not what they claim to be. */
export const POST = route({
  name: 'attachments.add',
  access: { kind: 'authenticated' },
  body: z.object({
    entityType: z.string().regex(/^[a-z_.]{1,40}$/),
    entityId: z.string().uuid(),
    filename: z.string().trim().min(1).max(200),
    contentType: z.string().max(100).optional(),
    dataBase64: z.string().min(8).max(30_000_000),
  }),
  handler: (rc, body) => attach(rc, body),
})
