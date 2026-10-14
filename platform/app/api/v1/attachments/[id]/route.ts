import { route, FileResponse } from '@/server/http'
import { getDb } from '@/server/db/client'
import { downloadAttachment } from '@/server/attachments'
import { fail, ok } from '@/server/command/result'

export const dynamic = 'force-dynamic'

/** Download. 404 unless the actor may see the record it hangs on. Always an attachment download with nosniff. */
export const GET = route({
  name: 'attachments.download',
  access: { kind: 'authenticated' },
  handler: async (rc, _b, _req, _reply, { params }) => {
    if (!/^[0-9a-f-]{36}$/i.test(params.id ?? '')) return fail.notFound()
    const f = await downloadAttachment(getDb(), rc.actor, params.id)
    return f ? ok(new FileResponse(f.bytes, f.filename, f.contentType)) : fail.notFound()
  },
})
