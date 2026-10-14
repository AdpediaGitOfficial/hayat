/**
 * Working a clearance case (D-71, AT-020). The case stays open after the login is revoked, so an authorised admin completes items
 * ON THE FORMER EMPLOYEE'S BEHALF and the actor, the "on behalf of" and the time are recorded on the item, in the case history and
 * in the audit log.
 *
 *   completeItem      Reception-, AA- and Maintenance-owned items (Maintenance items only by the Maintenance Coordinator)
 *   markOutstanding   a mandatory item that cannot be done now: Outstanding, with a note and the owner who follows it up (SRS 5.6 step 32)
 *   reopenItem        Accommodation Admin, with a reason
 *   waiveItem         Policy Approver only, reason AND evidence, re-confirmed, never on one's own case. A waiver is final.
 *
 * A key or asset item has no state anyone can type in: it follows the keys register. A lost or damaged one is never marked returned (D-73).
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { clearanceItem, type ClearanceOwner } from '@/server/db/schema.exit'
import { audit } from '@/server/audit'
import { notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { confirmPassword } from '@/server/auth/reauth'
import { notify } from '@/server/notify'
import { OWNER_LABEL, nextActionFor } from './rules'
import { loadItemLocked, logEvent as logEvent2, setState } from '@/server/commands/keys/shared'
import {
  attachmentsOnItem, authorizeAtSite, caseItems, idSchema, logEvent, loadCaseLocked, reasonSchema, refreshCaseStatus, resolveItems, syncHandoverItems,
  type CaseRow, type ResolvedItem,
} from './shared'

const noteText = z.string().trim().min(1).max(500)
const attachmentIds = z.array(idSchema).max(10).optional()

export const completeInput = z.object({ itemId: idSchema, note: noteText.nullish(), attachmentIds })
export const outstandingInput = z.object({ itemId: idSchema, note: noteText, owner: z.enum(['Reception', 'Maintenance', 'AA']).optional() })
export const reopenInput = z.object({ itemId: idSchema, reason: reasonSchema })
export const waiveInput = z.object({
  itemId: idSchema,
  reason: reasonSchema,
  evidence: z.string().trim().min(3, 'Describe the evidence (at least 3 characters)').max(1000),
  attachmentIds,
  confirmPassword: z.string().max(200).optional(),
})
export type CompleteItemInput = z.infer<typeof completeInput>
export type OutstandingInput = z.infer<typeof outstandingInput>
export type ReopenItemInput = z.infer<typeof reopenInput>
export type WaiveItemInput = z.infer<typeof waiveInput>

export interface ItemOut { itemId: string; caseId: string; status: 'open' | 'done' | 'waived' | 'outstanding'; caseStatus: string; repeated?: boolean }

interface Loaded { kase: CaseRow; item: ResolvedItem }

/** Finds the item, locks its case and the case's items, and answers 404 for anything outside the actor's reach. */
async function load(c: CommandContext, itemId: string): Promise<Loaded | Failure> {
  const [peek] = await c.tx.select({ caseId: clearanceItem.caseId }).from(clearanceItem).where(eq(clearanceItem.id, itemId)).limit(1)
  if (!peek) return fail.notFound()
  const kase = await loadCaseLocked(c.tx, peek.caseId)
  if (!kase) return fail.notFound()
  const seen = authorizeAtSite(c, 'exit_clearance.view', kase.siteId)
  if (seen) return seen
  const items = resolveItems(await caseItems(c.tx, kase.id, true), kase.staffId)
  const item = items.find(i => i.id === itemId)
  return item ? { kase, item } : fail.notFound()
}
const isFail = (x: Loaded | Failure): x is Failure => 'ok' in x

/** Maintenance-owned items are the Maintenance Coordinator's (exit_clearance.inspection_item); the rest are Reception's, the AA's and the SA's. */
function mayWork(c: CommandContext, l: Loaded): Failure | undefined {
  const owner = l.item.owner
  const denied = authorizeAtSite(c, owner === 'Maintenance' ? 'exit_clearance.inspection_item' : 'exit_clearance.clearance_task', l.kase.siteId)
  if (!denied) return undefined
  if (denied.code === 'forbidden') {
    return failure('forbidden', owner === 'Maintenance' ? 'Only the Maintenance Coordinator can complete an inspection item' : 'Only Reception, an Accommodation Admin or a Super Admin can work clearance items', {
      owner: OWNER_LABEL[owner], next: owner === 'Maintenance' ? 'Ask the Maintenance Coordinator of this site to complete it' : 'Ask Reception or an Accommodation Admin',
    })
  }
  return denied
}

function frozen(l: Loaded): Failure | undefined {
  if (l.kase.status === 'cleared') return failure('conflict', 'This clearance case is already cleared and cannot change', { owner: 'Accommodation Admin', next: 'Nothing to do. A new exit opens a new case' })
  return undefined
}

const snap = (i: ResolvedItem) => ({ label: i.label, stored: i.status, effective: i.effective, owner: i.owner })

/* ---------------- complete ---------------- */

export function completeItem(rc: RequestContext, i: CompleteItemInput): Promise<Result<ItemOut>> {
  return runCommand(rc, async c => {
    const l = await load(c, i.itemId)
    if (isFail(l)) return l
    const denied = mayWork(c, l)
    if (denied) return denied
    const self = notSelf(c, l.kase.staffId, 'complete clearance items')
    if (self) return self
    const gone = frozen(l)
    if (gone) return gone
    const { kase, item } = l
    if (item.status === 'waived') return failure('conflict', 'This item was waived by the Policy Approver', { owner: 'Policy Approver', next: 'Nothing to do' })

    if (item.kind === 'handover') {
      // The register decides (D-73): a lost or damaged key is never marked returned; a held one is returned in Keys & assets.
      if (item.effective === 'done') {
        await syncHandoverItems(c.tx, kase, c.now)
        return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'done', caseStatus: await refreshCaseStatus(c.tx, kase), repeated: true }, 'The keys register already shows this item as returned.')
      }
      if (item.lostOrDamaged) {
        return failure('conflict', `${item.label} is recorded as ${item.live?.status}. A lost or damaged key is never marked returned (D-73)`, {
          owner: OWNER_LABEL.AA, next: nextActionFor({ ...item, kind: 'handover' }), detail: { reason: 'lost_or_damaged', itemId: item.id },
        })
      }
      return failure('conflict', `${item.label} is still recorded as held by the former employee`, {
        owner: OWNER_LABEL.Reception, next: 'Record the return in Keys & assets; this item then turns Done by itself', detail: { reason: 'still_held', itemId: item.id },
      })
    }
    if (item.status === 'done') return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'done', caseStatus: kase.status, repeated: true }, 'Already done.')
    const ev = await attachmentsOnItem(c.tx, item.id, i.attachmentIds)
    if (!ev.ok) return fail.invalid('An attachment does not belong to this item', { attachmentIds: 'Upload the file to this item first' })

    await c.tx.update(clearanceItem).set({ status: 'done', doneBy: c.user.id, doneAt: c.now, onBehalfOfStaffId: kase.staffId, note: i.note ?? null }).where(eq(clearanceItem.id, item.id))
    await logEvent(c.tx, { caseId: kase.id, itemId: item.id, kind: 'item_done', actorUserId: c.user.id, onBehalfOfStaffId: kase.staffId, note: i.note ?? null, at: c.now })
    await audit(c, {
      action: 'exit.clearance.item_done', entityType: 'clearance_item', entityId: item.id, siteId: kase.siteId ?? undefined, reason: i.note ?? undefined,
      before: snap(item), after: { ...snap(item), stored: 'done', effective: 'done', doneBy: c.user.id, onBehalfOfStaffId: kase.staffId, caseId: kase.id, attachmentIds: i.attachmentIds ?? [] },
    })
    return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'done', caseStatus: await refreshCaseStatus(c.tx, kase) }, `${item.label}: done, recorded on the former employee's behalf.`)
  })
}

/* ---------------- outstanding ---------------- */

export function markOutstanding(rc: RequestContext, i: OutstandingInput): Promise<Result<ItemOut>> {
  return runCommand(rc, async c => {
    const l = await load(c, i.itemId)
    if (isFail(l)) return l
    const denied = mayWork(c, l)
    if (denied) return denied
    const self = notSelf(c, l.kase.staffId, 'work on your own clearance')
    if (self) return self
    const gone = frozen(l)
    if (gone) return gone
    const { kase, item } = l
    if (item.status === 'waived') return failure('conflict', 'This item was waived by the Policy Approver', { owner: 'Policy Approver', next: 'Nothing to do' })
    if (item.kind === 'handover') {
      return failure('conflict', 'The state of a key or asset comes from the keys register', { owner: OWNER_LABEL.Reception, next: 'Record it as lost or damaged in Keys & assets, and this item turns Outstanding by itself' })
    }
    if (item.status === 'done') return failure('conflict', 'This item is already done', { owner: OWNER_LABEL[item.owner], next: 'An Accommodation Admin can reopen it first' })
    const owner: ClearanceOwner = i.owner ?? item.owner
    await c.tx.update(clearanceItem).set({ status: 'outstanding', note: i.note, owner, doneBy: null, doneAt: null, onBehalfOfStaffId: null }).where(eq(clearanceItem.id, item.id))
    await logEvent(c.tx, { caseId: kase.id, itemId: item.id, kind: 'item_outstanding', actorUserId: c.user.id, onBehalfOfStaffId: kase.staffId, note: `${i.note} (owner: ${OWNER_LABEL[owner]})`, at: c.now })
    await audit(c, {
      action: 'exit.clearance.item_outstanding', entityType: 'clearance_item', entityId: item.id, siteId: kase.siteId ?? undefined, reason: i.note,
      before: snap(item), after: { ...snap(item), stored: 'outstanding', effective: 'outstanding', owner, caseId: kase.id },
    })
    return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'outstanding', caseStatus: await refreshCaseStatus(c.tx, kase) }, `${item.label}: recorded as outstanding with ${OWNER_LABEL[owner]}.`)
  })
}

/* ---------------- reopen ---------------- */

export function reopenItem(rc: RequestContext, i: ReopenItemInput): Promise<Result<ItemOut>> {
  return runCommand(rc, async c => {
    const l = await load(c, i.itemId)
    if (isFail(l)) return l
    const denied = authorizeAtSite(c, 'exit_clearance.manage_case', l.kase.siteId)
    if (denied) return denied
    const self = notSelf(c, l.kase.staffId, 'work on your own clearance')
    if (self) return self
    const gone = frozen(l)
    if (gone) return gone
    const { kase, item } = l
    if (item.status === 'waived') return failure('conflict', 'A waiver is final: only the Policy Approver decided it', { owner: 'Policy Approver', next: 'Ask the Policy Approver if the waiver was a mistake' })
    if (item.kind === 'handover') {
      return failure('conflict', 'The state of a key or asset comes from the keys register', { owner: OWNER_LABEL.Reception, next: 'Correct the record in Keys & assets' })
    }
    if (item.status === 'open') return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'open', caseStatus: kase.status, repeated: true }, 'Already open.')
    await c.tx.update(clearanceItem).set({ status: 'open', doneBy: null, doneAt: null, onBehalfOfStaffId: null, note: i.reason }).where(eq(clearanceItem.id, item.id))
    await logEvent(c.tx, { caseId: kase.id, itemId: item.id, kind: 'item_reopened', actorUserId: c.user.id, onBehalfOfStaffId: kase.staffId, note: i.reason, at: c.now })
    await audit(c, {
      action: 'exit.clearance.item_reopened', entityType: 'clearance_item', entityId: item.id, siteId: kase.siteId ?? undefined, reason: i.reason,
      before: snap(item), after: { ...snap(item), stored: 'open', effective: 'open', caseId: kase.id },
    })
    return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'open', caseStatus: await refreshCaseStatus(c.tx, kase) }, `${item.label}: reopened.`)
  })
}

/* ---------------- waive ---------------- */

/**
 * The Policy Approver alone may waive an item (D-71): a mandatory item that cannot be done, or a lost key that will not come back.
 * Reason AND evidence are mandatory, the password is re-confirmed (D-03), it is audited, and it is never the person's own case.
 * It is a direct decision, not a request in the inbox: the Policy Approver is the end of the line, there is nobody to route it to.
 */
export function waiveItem(rc: RequestContext, i: WaiveItemInput): Promise<Result<ItemOut>> {
  return runCommand(rc, async c => {
    const l = await load(c, i.itemId)
    if (isFail(l)) return l
    const denied = authorizeAtSite(c, 'exit_clearance.waive', l.kase.siteId)
    if (denied) {
      return denied.code === 'forbidden'
        ? failure('forbidden', 'Only a Policy Approver can waive a clearance item', { owner: 'Policy Approver', next: 'Ask a Policy Approver of this site, with the reason and the evidence' })
        : denied
    }
    const self = notSelf(c, l.kase.staffId, 'waive items on your own clearance')
    if (self) return self
    const gone = frozen(l)
    if (gone) return gone
    const { kase, item } = l
    if (item.status === 'waived') return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'waived', caseStatus: kase.status, repeated: true }, 'Already waived.')
    if (item.effective === 'done') return failure('conflict', 'This item is done, so there is nothing to waive', { owner: OWNER_LABEL[item.owner], next: 'Nothing to do' })
    const bad = await confirmPassword(c, i.confirmPassword)
    if (bad) return bad
    const ev = await attachmentsOnItem(c.tx, item.id, i.attachmentIds)
    if (!ev.ok) return fail.invalid('An attachment does not belong to this item', { attachmentIds: 'Upload the file to this item first' })

    await c.tx.update(clearanceItem).set({
      status: 'waived', waivedBy: c.user.id, waivedAt: c.now, waiverReason: i.reason, waiverEvidence: i.evidence, onBehalfOfStaffId: kase.staffId,
    }).where(eq(clearanceItem.id, item.id))
    // A waived key or asset is written off: the Policy Approver accepted that it will not come back, so the register retires it
    // (never "returned", D-73) and it stops holding the stay open. The history keeps who held it and why it was retired.
    const [link] = await c.tx.select({ handoverId: clearanceItem.handoverItemId }).from(clearanceItem).where(eq(clearanceItem.id, item.id)).limit(1)
    if (item.kind === 'handover' && link?.handoverId) {
      const hi = await loadItemLocked(c.tx, link.handoverId)
      if (hi && ['issued', 'lost', 'damaged'].includes(hi.status)) {
        await setState(c, hi.id, { status: 'retired', holderStaffId: null, issuedAt: null, dueBack: null })
        await logEvent2(c, { itemId: hi.id, kind: 'retired', staffId: hi.holderStaffId, onBehalf: true, note: `Written off by a Policy Approver waiver: ${i.reason}` })
        await audit(c, { action: 'keys.item.written_off', entityType: 'handover_item', entityId: hi.id, siteId: hi.siteId, reason: i.reason, before: { status: hi.status, holder: hi.holderStaffId }, after: { status: 'retired', via: 'clearance waiver', clearanceItemId: item.id } })
      }
    }
    await logEvent(c.tx, { caseId: kase.id, itemId: item.id, kind: 'item_waived', actorUserId: c.user.id, onBehalfOfStaffId: kase.staffId, note: `${i.reason}. Evidence: ${i.evidence}`, at: c.now })
    await audit(c, {
      action: 'exit.clearance.item_waived', entityType: 'clearance_item', entityId: item.id, siteId: kase.siteId ?? undefined, reason: i.reason,
      before: snap(item), after: { ...snap(item), stored: 'waived', effective: 'waived', waivedBy: c.user.id, evidence: i.evidence, attachmentIds: i.attachmentIds ?? [], caseId: kase.id, mandatory: item.mandatory },
    })
    await notify(c.tx, {
      dedupeKey: `clearance:item:${item.id}:waived`, kind: 'exit.item_waived', to: kase.siteId ? { role: 'AA', siteId: kase.siteId } : { role: 'AA' }, ref: { type: 'clearance_case', id: kase.id },
      text: `A Policy Approver waived "${item.label}" in a clearance case. Reason: ${i.reason}`,
    })
    return ok<ItemOut>({ itemId: item.id, caseId: kase.id, status: 'waived', caseStatus: await refreshCaseStatus(c.tx, kase) }, `${item.label}: waived. The reason and evidence are on record.`)
  })
}
