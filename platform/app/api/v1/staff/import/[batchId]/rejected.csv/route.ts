import { route } from '@/server/http'
import { exportRejectedRows } from '@/server/commands/staff/importRejected'

export const dynamic = 'force-dynamic'

const inner = route({
  name: 'staff.import.rejected',
  access: { kind: 'action', action: 'staff_directory.import_csv' },
  handler: (rc, _b, _req, _reply, { params }) => exportRejectedRows(rc, { batchId: params.batchId }),
})

/**
 * The rejected rows as a CSV download, with the reason for each. route() answers JSON; on success this wrapper unpacks the
 * file from that answer and returns it as an attachment. Every refusal (401, 403, 404, ...) passes through unchanged, and the
 * wrapper keeps route()'s metadata so the permission contract test still sees the declared access.
 */
export const GET = Object.assign(
  async (req: Request, ctx?: { params?: Record<string, string> }): Promise<Response> => {
    const res = await inner(req, ctx)
    if (res.status !== 200) return res
    const body = await res.json() as { data: { filename: string; csv: string }; requestId: string }
    return new Response(body.data.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${body.data.filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': body.requestId,
      },
    })
  },
  { meta: inner.meta },
)
