import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { accommodationRequest } from '@/server/db/schema'
import { audit } from '@/server/audit'
import { authorize } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { fmtDate } from '@/domain/time'
import { dateSchema, idSchema, isRequester, loadRequest, revisionOf, snapRequest, stayTypeSchema, type RequestRow } from './shared'
import { checkSubmitAccess, validateFields } from './rules'

/** Loads the request for a requester action: 404 when not visible, 403 when visible but not theirs. */
async function loadForRequester(c: CommandContext, id: string, what: string): Promise<Failure | RequestRow> {
  const peek = await loadRequest(c.tx, id)
  if (!peek) return fail.notFound()
  const denied = authorize(c, 'requests_waitlist.view', { siteId: peek.siteId, ownerStaffId: peek.staffId })
  if (denied) return denied
  if (!isRequester(c, peek)) return fail.forbidden(what, 'The person who filed the request')
  const r = await loadRequest(c.tx, id, true)
  return r ?? fail.notFound()
}

const notEditable = (r: RequestRow): Failure => r.status === 'submitted' || r.status === 'pending_approval'
  ? failure('conflict', 'This request is with an approver, so it cannot be edited now', { owner: 'Accommodation Admin', next: 'Cancel it and file a new one, or wait: the admin can send it back for changes' })
  : failure('conflict', `This request is ${r.status.replace(/_/g, ' ')} and can no longer be edited`, { owner: 'The requester', next: 'File a new request if the need is still there' })

export const editInput = z.object({
  requestId: idSchema,
  siteId: idSchema.optional(),
  arrivalDate: dateSchema.optional(),
  /** undefined keeps the current value, null clears it (allowed for permanent stays only). */
  endDate: dateSchema.nullable().optional(),
  stayType: stayTypeSchema.optional(),
  note: z.string().trim().max(500, 'At most 500 characters').nullable().optional(),
  /** Send it back to the approver in the same step. */
  resubmit: z.boolean().optional(),
})
export type EditRequestInput = z.infer<typeof editInput>

async function resubmitIn(c: CommandContext, r: RequestRow): Promise<RequestRow> {
  const [row] = await c.tx.update(accommodationRequest).set({ status: 'submitted', decisionReason: null, decidedBy: null, decidedAt: null }).where(eq(accommodationRequest.id, r.id)).returning()
  const n = await revisionOf(c.tx, r.id)
  await audit(c, { action: 'requests.request.resubmitted', entityType: 'request', entityId: r.id, siteId: r.siteId, before: { status: r.status }, after: { status: 'submitted', revision: n } })
  await notify(c.tx, {
    dedupeKey: `request:${r.id}:resubmitted:${n}`, kind: 'request.resubmitted', to: { role: 'AA', siteId: r.siteId }, ref: { type: 'request', id: r.id },
    text: `A request you sent back was updated and resubmitted (arriving ${fmtDate(row.arrivalDate)})`,
  })
  return row
}

/** The requester changes the fields of a request that was sent back (D-43). Only `changes_requested` can be edited. */
export function editRequest(rc: RequestContext, i: EditRequestInput): Promise<Result<{ requestId: string; status: string }>> {
  return runCommand(rc, async c => {
    const r = await loadForRequester(c, i.requestId, 'change this request')
    if ('ok' in r) return r
    if (r.status !== 'changes_requested') return notEditable(r)

    const next = {
      siteId: i.siteId ?? r.siteId,
      arrivalDate: i.arrivalDate ?? r.arrivalDate,
      endDate: i.endDate === undefined ? r.endDate : i.endDate,
      stayType: i.stayType ?? r.stayType,
      note: i.note === undefined ? r.note : (i.note || null),
    }
    if (next.siteId !== r.siteId) {
      // Changing the site is the "send it back, change, resubmit" route (S-12): the new site must be one the actor may use.
      const denied = checkSubmitAccess(c, next.siteId, r.staffId)
      if (denied) return denied
    }
    const v = await validateFields(c, next)
    if ('ok' in v) return v

    let [row] = await c.tx.update(accommodationRequest).set(next).where(eq(accommodationRequest.id, r.id)).returning()
    await audit(c, { action: 'requests.request.edited', entityType: 'request', entityId: r.id, siteId: row.siteId, before: snapRequest(r), after: snapRequest(row) })
    if (i.resubmit) row = await resubmitIn(c, row)
    return ok({ requestId: row.id, status: row.status }, i.resubmit ? 'Request updated and sent back to the Accommodation Admin.' : 'Changes saved. Resubmit when you are ready.')
  })
}

export const resubmitInput = z.object({ requestId: idSchema })

/** Sends an edited request back for approval. The dates are checked again: an arrival that has passed must be changed first. */
export function resubmitRequest(rc: RequestContext, i: z.infer<typeof resubmitInput>): Promise<Result<{ requestId: string; status: string }>> {
  return runCommand(rc, async c => {
    const r = await loadForRequester(c, i.requestId, 'resubmit this request')
    if ('ok' in r) return r
    if (r.status !== 'changes_requested') {
      if (r.status === 'submitted') return ok({ requestId: r.id, status: r.status }, 'Already with the Accommodation Admin.') // a retried call
      return notEditable(r)
    }
    const v = await validateFields(c, r)
    if ('ok' in v) return fail.invalid('The dates need updating before this can go back', v.fields)
    const row = await resubmitIn(c, r)
    return ok({ requestId: row.id, status: row.status }, 'Request sent back to the Accommodation Admin.')
  })
}
