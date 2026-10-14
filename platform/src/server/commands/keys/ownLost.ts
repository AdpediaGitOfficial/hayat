/**
 * A resident reports a key or asset THEY hold as lost (P-05, PROPOSED, pending client sign-off; setting `keys.resident_may_report_lost`,
 * default OFF; policy action `keys.report_own_lost`, Resident, own scope).
 *
 * What it is: the one movement a resident may record, and only this one. The item goes `issued` -> `lost`, the holder is kept (a lost item
 * is still the holder's until it is found, replaced or retired, D-73), the event is `lost` with `on_behalf: false` and a mandatory short
 * note. Reception at the site and the Accommodation Admin are told. It is audited.
 *
 * What it is not: the resident can never mark anything returned or found; those commands stay with staff (`keys.issue_return`,
 * `keys.issue_return_night`, `keys.manage`). The separation-of-duties rule that stops staff recording a lost key against their own
 * record does not apply here: it is the holder reporting, which is the point, and the only thing they can do.
 *
 * Another person's item reads as "not found" whatever the setting says, so the screen and the API never reveal what others hold.
 */
import { z } from 'zod'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { notify } from '@/server/notify'
import { decide } from '@/server/policy'
import { deskHours } from './hours'
import { idSchema, itemSnap, loadItemLocked, logEvent, reasonSchema, setState } from './shared'

export const reportOwnLostInput = z.object({ itemId: idSchema, note: reasonSchema })
export type ReportOwnLostInput = z.infer<typeof reportOwnLostInput>
export interface ReportOwnLostOut { id: string; code: string; status: 'lost' }

export function reportOwnLost(rc: RequestContext, i: ReportOwnLostInput): Promise<Result<ReportOwnLostOut>> {
  return runCommand(rc, async c => {
    const note = i.note.trim()
    if (note.length < 3) return fail.invalid('Say briefly what happened', { note: 'Give a reason (at least 3 characters)' })
    const item = await loadItemLocked(c.tx, i.itemId)
    if (!item) return fail.notFound()
    // Scope first: it is not theirs (or not an item at all) = not found, before the setting is even looked at.
    const d = decide(c.actor, 'keys.report_own_lost', { siteId: item.siteId, ownerStaffId: item.holderStaffId ?? undefined })
    if (!d.allowed) return d.reason === 'out_of_scope' ? fail.notFound() : fail.forbidden('report a key or asset as lost')
    if (!(await getConfig(c.tx, 'keys.resident_may_report_lost', item.siteId))) {
      return failure('forbidden', 'Reporting your own key or asset as lost from here is not in force (it is a proposed rule, pending client sign-off). Reception records it for you', {
        owner: 'Reception', next: 'Tell Reception', detail: { reason: 'policy_not_in_force', proposal: 'P-05' },
      })
    }
    if (item.archivedAt || item.status !== 'issued') {
      return failure('conflict', item.status === 'lost' || item.status === 'damaged' ? `This is already recorded as ${item.status}` : 'This item is not out on your record', {
        owner: 'Reception', next: item.status === 'lost' || item.status === 'damaged' ? 'Nothing more to do. The Accommodation Admin will contact you' : 'Tell Reception', detail: { reason: 'not_issued', status: item.status },
      })
    }
    const hrs = await deskHours(c.tx, c.now, item.siteId)
    await setState(c, item.id, { status: 'lost', holderStaffId: item.holderStaffId, issuedAt: item.issuedAt, dueBack: item.dueBack })
    const eventId = await logEvent(c, { itemId: item.id, kind: 'lost', staffId: item.holderStaffId, onBehalf: false, note, afterHours: hrs.afterHours })
    await audit(c, {
      action: 'keys.item.lost', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: note, before: itemSnap(item),
      after: { ...itemSnap({ ...item, status: 'lost' }), reportedBy: 'holder', afterHours: hrs.afterHours },
    })
    const what = `${item.itemType.replace(/_/g, ' ')} ${item.code}`
    const text = `${what} was reported lost by the person who holds it. It stays on their record until it is found, replaced or retired.`
    await notify(c.tx, { dedupeKey: `handover:${eventId}:lost:rec`, kind: 'keys.lost', to: { role: 'Rec', siteId: item.siteId }, ref: { type: 'handover_item', id: item.id }, text })
    await notify(c.tx, { dedupeKey: `handover:${eventId}:lost:aa`, kind: 'keys.lost', to: { role: 'AA', siteId: item.siteId }, ref: { type: 'handover_item', id: item.id }, text: `${text} Decide whether to find, replace or retire it.` })
    return ok<ReportOwnLostOut>({ id: item.id, code: item.code, status: 'lost' }, `${what} reported lost. Reception and the Accommodation Admin have been told`)
  })
}
