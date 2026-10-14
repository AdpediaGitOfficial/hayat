/**
 * Closing a clearance case (D-71). Refused while a mandatory item is Open or Outstanding; the refusal lists each one with its owner
 * and the next action. A waiver by the Policy Approver is the only way past an item that cannot be done.
 *
 * Clearing the case does not check anyone out and does not free a bed (D-64). It may be the last thing a stay was waiting for: then
 * closeStayIfDone() closes the stay (checked out AND cleared AND nothing held). When the stay is checked out later, checkout calls
 * closeStayIfDone() itself.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { stay } from '@/server/db/schema'
import { clearanceCase } from '@/server/db/schema.exit'
import { audit } from '@/server/audit'
import { notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { closeStayIfDone } from '@/server/stays-close'
import { closeBlockers } from './rules'
import { authorizeAtSite, caseItems, ensureHandoverItems, idSchema, loadCaseLocked, loadPerson, logEvent, resolveItems, syncHandoverItems } from './shared'

export const closeInput = z.object({ caseId: idSchema })
export type CloseCaseInput = z.infer<typeof closeInput>
export interface CloseCaseOut { caseId: string; status: 'cleared'; clearedAt: string; staysClosed: string[]; repeated?: boolean }

export function closeCase(rc: RequestContext, i: CloseCaseInput): Promise<Result<CloseCaseOut>> {
  return runCommand(rc, async c => {
    const peek = await loadCaseLocked(c.tx, i.caseId)
    if (!peek) return fail.notFound()
    const seen = authorizeAtSite(c, 'exit_clearance.view', peek.siteId)
    if (seen) return seen
    const denied = authorizeAtSite(c, 'exit_clearance.manage_case', peek.siteId)
    if (denied) return denied
    const self = notSelf(c, peek.staffId, 'close your own clearance case')
    if (self) return self
    if (peek.status === 'cleared') return ok<CloseCaseOut>({ caseId: peek.id, status: 'cleared', clearedAt: peek.clearedAt!.toISOString(), staysClosed: [], repeated: true }, 'Already cleared.')

    // Keys and assets are read from the register: anything held since the case opened is added, anything returned is written down as Done.
    await ensureHandoverItems(c.tx, peek, c.user.id, c.now)
    await syncHandoverItems(c.tx, peek, c.now)
    const items = resolveItems(await caseItems(c.tx, peek.id), peek.staffId)
    const blockers = closeBlockers(items)
    if (blockers.length > 0) {
      const owners = [...new Set(blockers.map(b => b.owner))]
      return failure('conflict', `${blockers.length} mandatory item${blockers.length === 1 ? ' is' : 's are'} not complete: ${blockers.map(b => b.label).join('; ')}`, {
        owner: owners.join(', '), next: blockers[0].next, detail: { reason: 'mandatory_items', blockers },
      })
    }

    const [updated] = await c.tx.update(clearanceCase).set({ status: 'cleared', clearedBy: c.user.id, clearedAt: c.now })
      .where(and(eq(clearanceCase.id, peek.id), isNull(clearanceCase.clearedAt))).returning({ id: clearanceCase.id })
    if (!updated) return failure('conflict', 'Another admin just cleared this case', { owner: 'Accommodation Admin', next: 'Reload the case' })
    await logEvent(c.tx, { caseId: peek.id, kind: 'closed', actorUserId: c.user.id, onBehalfOfStaffId: peek.staffId, note: `${items.filter(x => x.effective === 'waived').length} waived, ${items.filter(x => x.effective === 'done').length} done`, at: c.now })

    // The stays this clearance may have been the last thing for: the flagged one, and any that were checked out earlier and never closed.
    const candidates = new Set<string>(peek.stayId ? [peek.stayId] : [])
    for (const s of await c.tx.select({ id: stay.id }).from(stay).where(and(eq(stay.staffId, peek.staffId), eq(stay.status, 'checked_out')))) candidates.add(s.id)
    const staysClosed: string[] = []
    for (const id of candidates) if (await closeStayIfDone(c.tx, id, c.now)) staysClosed.push(id)

    const p = await loadPerson(c.tx, peek.staffId)
    await audit(c, {
      action: 'exit.clearance.cleared', entityType: 'clearance_case', entityId: peek.id, siteId: peek.siteId ?? undefined,
      before: { status: peek.status }, after: { status: 'cleared', staysClosed, waived: items.filter(x => x.effective === 'waived').map(x => x.label), stayChanged: false, bedChanged: false },
    })
    await notify(c.tx, {
      dedupeKey: `clearance:${peek.id}:cleared`, kind: 'exit.cleared', to: peek.siteId ? { role: 'AA', siteId: peek.siteId } : { role: 'AA' }, ref: { type: 'clearance_case', id: peek.id },
      text: `Clearance for ${p?.fullName ?? 'a former employee'} (${p?.employeeId ?? ''}) is complete.${staysClosed.length ? ' The stay is closed.' : ' Checkout and the bed are tracked separately.'}`,
    })
    return ok<CloseCaseOut>({ caseId: peek.id, status: 'cleared', clearedAt: c.now.toISOString(), staysClosed }, 'Clearance complete. Checkout and bed readiness are tracked separately.')
  })
}
