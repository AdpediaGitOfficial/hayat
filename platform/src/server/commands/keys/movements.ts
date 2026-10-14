/**
 * Movements of keys and assets (WP-I): issue, return, lost, damaged, found, retire, replace.
 *
 * Every movement is ONE transaction that locks the item row, changes it, appends a handover_event and writes the audit row,
 * so the log can never disagree with the item. The rules (D-19, D-73, D-26):
 *  - only an item `in_cabinet` can be issued, to an active employee who is not the actor, and for an item tied to a bed or
 *    room only to someone with a live stay or reservation there; two simultaneous issues of one key: exactly one wins,
 *  - only an `issued` item can be returned (the holder may be a former employee: recorded `on_behalf`),
 *  - lost or damaged is a state, never a return: the item keeps its holder and the only exits are retire, replace
 *    (the new item is linked and the old one retired, D-73) and, for a lost item, found,
 *  - whatever resolves what a person held calls closeStayIfDone, so the last return can close a cleared stay (D-64).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { attachment, handoverItem } from '@/server/db/schema.stage3'
import { audit } from '@/server/audit'
import { notSelf } from '@/server/command/authorize'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { notify } from '@/server/notify'
import { duplicate, guardUnique, todayInZone } from '@/server/commands/property/shared'
import { site as siteTable } from '@/server/db/schema'
import {
  archivedFailure, attachmentIdsSchema, authorizeAny, closeStaysOf, codeSchema, dateSchema, holdabilityProblem, holdFailure, idSchema, itemSnap, itemTypeFailure,
  itemTypeSchema, loadItemLocked, logEvent, MOVE_ACTIONS, noteSchema, NOT_RETURNABLE, reasonSchema, resolveLinks, setState, staffRow, who, type ItemRow,
} from './shared'

export interface MoveOut { id: string; code: string; status: ItemRow['status']; holderStaffId: string | null; closedStays: string[] }
const out = (i: Pick<ItemRow, 'id' | 'code'>, status: ItemRow['status'], holder: string | null, closedStays: string[] = []): MoveOut => ({ id: i.id, code: i.code, status, holderStaffId: holder, closedStays })

const label = (i: Pick<ItemRow, 'code' | 'itemType'>) => `${i.itemType.replace(/_/g, ' ')} ${i.code}`

async function siteToday(c: CommandContext, siteId: string): Promise<string> {
  const [s] = await c.tx.select({ tz: siteTable.timeZone }).from(siteTable).where(eq(siteTable.id, siteId)).limit(1)
  return todayInZone(c.now, s?.tz ?? 'UTC')
}

/* ---------------- issue ---------------- */

export const issueInput = z.object({ itemId: idSchema, staffId: idSchema, dueBack: dateSchema.nullish().transform(v => v ?? null), note: noteSchema })
export type IssueItemInput = z.infer<typeof issueInput>

export function issueItem(rc: RequestContext, i: IssueItemInput): Promise<Result<MoveOut>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.itemId)               // the row lock: of two simultaneous issues, one waits here and then sees `issued`
    if (!item) return fail.notFound()
    const denied = authorizeAny(c, MOVE_ACTIONS, item.siteId)
    if (denied) return denied
    const self = notSelf(c, i.staffId, 'issue a key or asset to yourself')
    if (self) return self
    if (item.archivedAt) return archivedFailure()
    if (item.status !== 'in_cabinet') {
      const holder = item.holderStaffId ? await staffRow(c.tx, item.holderStaffId) : undefined
      const why = item.status === 'issued' ? `${label(item)} is already issued${holder ? ` to ${who(holder)}` : ''}`
        : item.status === 'retired' ? `${label(item)} is retired` : `${label(item)} is ${item.status}`
      return failure('conflict', why, {
        owner: 'Reception', next: item.status === 'issued' ? 'Record its return first, or issue a different one' : 'Choose another item from the cabinet', detail: { reason: 'not_in_cabinet', status: item.status },
      })
    }
    const person = await staffRow(c.tx, i.staffId, 'share')         // shared lock: Mark as Left cannot slip in between the check and the update
    if (!person) return fail.invalid('That person does not exist', { staffId: 'Not found' })
    const problem = await holdabilityProblem(c.tx, item, person, i.staffId)
    if (problem) return holdFailure(problem)
    if (i.dueBack && i.dueBack < await siteToday(c, item.siteId)) return fail.invalid('The due date is in the past', { dueBack: 'Choose today or later' })
    const links = await resolveLinks(c.tx, item.siteId, item.roomId, item.bedId)   // archive of the bed or room waits for us, or we see it archived
    if ('ok' in links) return links

    await setState(c, item.id, { status: 'issued', holderStaffId: i.staffId, issuedAt: c.now, dueBack: i.dueBack })
    const eventId = await logEvent(c, { itemId: item.id, kind: 'issued', staffId: i.staffId, note: i.note })
    await audit(c, { action: 'keys.item.issued', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.note ?? undefined, before: itemSnap(item), after: itemSnap({ ...item, status: 'issued', holderStaffId: i.staffId, dueBack: i.dueBack }) })
    await notify(c.tx, {
      dedupeKey: `handover:${eventId}:issued`, kind: 'keys.issued', to: { staffId: i.staffId }, ref: { type: 'handover_item', id: item.id },
      text: `${label(item)} was issued to you.${i.dueBack ? ` Please return it by ${i.dueBack}.` : ' Return it to Reception when you leave.'} Report it to Reception at once if it is lost or damaged.`,
    })
    return ok(out(item, 'issued', i.staffId), `${label(item)} issued to ${who(person)}`)
  })
}

/* ---------------- return ---------------- */

export const returnInput = z.object({ itemId: idSchema, note: noteSchema, onBehalf: z.boolean().optional() })
export type ReturnItemInput = z.infer<typeof returnInput>

/**
 * Takes an issued item back into the cabinet. The holder need not be present: a former employee's items are returned by
 * Reception on their behalf, which is recorded (`on_behalf`). Only an `issued` item can be returned.
 */
export function returnItem(rc: RequestContext, i: ReturnItemInput): Promise<Result<MoveOut>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.itemId)
    if (!item) return fail.notFound()
    const denied = authorizeAny(c, MOVE_ACTIONS, item.siteId)
    if (denied) return denied
    if (item.status === 'lost' || item.status === 'damaged') return NOT_RETURNABLE(item.status)
    if (item.status !== 'issued' || !item.holderStaffId) {
      return failure('conflict', item.status === 'in_cabinet' ? `${label(item)} is already in the cabinet` : `${label(item)} is ${item.status}, so it cannot be returned`, {
        owner: 'Reception', next: 'Nothing to return', detail: { reason: item.status === 'in_cabinet' ? 'already_in_cabinet' : 'not_issued', status: item.status },
      })
    }
    const self = notSelf(c, item.holderStaffId, 'record the return of your own key or asset')
    if (self) return self
    const holder = await staffRow(c.tx, item.holderStaffId)
    const onBehalf = i.onBehalf ?? (holder?.status === 'left')       // a former employee cannot be at the desk
    await setState(c, item.id, { status: 'in_cabinet', holderStaffId: null, issuedAt: null, dueBack: null })
    await logEvent(c, { itemId: item.id, kind: 'returned', staffId: item.holderStaffId, onBehalf, note: i.note })
    await audit(c, { action: 'keys.item.returned', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.note ?? undefined, before: itemSnap(item), after: { ...itemSnap({ ...item, status: 'in_cabinet', holderStaffId: null, dueBack: null }), onBehalf } })
    const closed = await closeStaysOf(c, item.holderStaffId)
    return ok(out(item, 'in_cabinet', null, closed), `${label(item)} returned${onBehalf ? ' on behalf of ' + (holder ? holder.name : 'the holder') : ''}`)
  })
}

/* ---------------- lost and damaged ---------------- */

/** Evidence uploaded onto this item beforehand (attachments service); every id must belong to it. */
async function evidenceFailure(c: CommandContext, itemId: string, ids: string[] | undefined): Promise<Failure | undefined> {
  const unique = [...new Set(ids ?? [])]
  if (unique.length === 0) return undefined
  const rows = await c.tx.select({ id: attachment.id }).from(attachment).where(and(eq(attachment.entityType, 'handover_item'), eq(attachment.entityId, itemId), inArray(attachment.id, unique)))
  return rows.length === unique.length ? undefined : fail.invalid('Some of the files are not attached to this item', { attachmentIds: 'Upload the files to this item first' })
}

const problemInput = z.object({ itemId: idSchema, note: reasonSchema, attachmentIds: attachmentIdsSchema })
export const lostInput = problemInput
export const damagedInput = problemInput
export type MarkProblemInput = z.infer<typeof problemInput>

function markProblem(kind: 'lost' | 'damaged') {
  return (rc: RequestContext, i: MarkProblemInput): Promise<Result<MoveOut>> => runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.itemId)
    if (!item) return fail.notFound()
    const denied = authorizeAny(c, MOVE_ACTIONS, item.siteId)
    if (denied) return denied
    if (item.archivedAt) return archivedFailure()
    if (item.status !== 'in_cabinet' && item.status !== 'issued') {
      return failure('conflict', `${label(item)} is already ${item.status}`, { owner: 'Accommodation Admin', next: item.status === 'retired' ? 'Nothing to record' : 'Resolve it: found, replaced or retired', detail: { reason: 'not_markable', status: item.status } })
    }
    const self = notSelf(c, item.holderStaffId, `record your own ${kind} key or asset`)
    if (self) return self
    const bad = await evidenceFailure(c, item.id, i.attachmentIds)
    if (bad) return bad
    // The holder stays: a lost or damaged item is still the holder's until it is resolved (D-73). It is never "returned".
    await setState(c, item.id, { status: kind, holderStaffId: item.holderStaffId, issuedAt: item.issuedAt, dueBack: item.dueBack })
    const eventId = await logEvent(c, { itemId: item.id, kind, staffId: item.holderStaffId, note: i.note })
    await audit(c, { action: `keys.item.${kind}`, entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.note, before: itemSnap(item), after: { ...itemSnap({ ...item, status: kind }), attachmentIds: i.attachmentIds ?? [] } })
    await notify(c.tx, {
      dedupeKey: `handover:${eventId}:${kind}`, kind: `keys.${kind}`, to: { role: 'AA', siteId: item.siteId }, ref: { type: 'handover_item', id: item.id },
      text: `${label(item)} was reported ${kind}. Decide whether to find, replace or retire it. It stays on the holder's clearance until then.`,
    })
    return ok(out(item, kind, item.holderStaffId), `${label(item)} recorded as ${kind}. It is not returned: retire or replace it, or mark it found`)
  })
}
export const markLost = markProblem('lost')
export const markDamaged = markProblem('damaged')

/* ---------------- found ---------------- */

export const foundInput = z.object({ itemId: idSchema, to: z.enum(['holder', 'cabinet']), note: noteSchema })
export type FoundItemInput = z.infer<typeof foundInput>

/** A lost item turned up: back with its holder (issued again) or into the cabinet. A damaged item is not "found". */
export function foundItem(rc: RequestContext, i: FoundItemInput): Promise<Result<MoveOut>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.itemId)
    if (!item) return fail.notFound()
    const denied = authorizeAny(c, MOVE_ACTIONS, item.siteId)
    if (denied) return denied
    if (item.status !== 'lost') return failure('conflict', `${label(item)} is ${item.status.replace('_', ' ')}, not lost`, { owner: 'Accommodation Admin', next: 'Only a lost item can be marked found', detail: { reason: 'not_lost', status: item.status } })
    const self = notSelf(c, item.holderStaffId, 'record that your own lost key or asset was found')
    if (self) return self
    if (i.to === 'holder' && !item.holderStaffId) return fail.invalid('This item had no holder, so it can only go back into the cabinet', { to: 'Choose the cabinet' })
    const toHolder = i.to === 'holder'
    await setState(c, item.id, toHolder ? { status: 'issued', holderStaffId: item.holderStaffId, issuedAt: item.issuedAt, dueBack: item.dueBack } : { status: 'in_cabinet', holderStaffId: null, issuedAt: null, dueBack: null })
    await logEvent(c, { itemId: item.id, kind: 'found', staffId: item.holderStaffId, note: [toHolder ? 'Back with the holder' : 'Back in the cabinet', i.note].filter(Boolean).join('. ') })
    await audit(c, { action: 'keys.item.found', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.note ?? undefined, before: itemSnap(item), after: itemSnap({ ...item, status: toHolder ? 'issued' : 'in_cabinet', holderStaffId: toHolder ? item.holderStaffId : null }) })
    const closed = !toHolder && item.holderStaffId ? await closeStaysOf(c, item.holderStaffId) : []
    return ok(out(item, toHolder ? 'issued' : 'in_cabinet', toHolder ? item.holderStaffId : null, closed), `${label(item)} found${toHolder ? ' and back with the holder' : ' and back in the cabinet'}`)
  })
}

/* ---------------- retire ---------------- */

export const retireInput = z.object({ itemId: idSchema, reason: reasonSchema })
export type RetireItemInput = z.infer<typeof retireInput>

/**
 * Takes an item out of use for good (a lost key that will not be found, a worn-out card). Accommodation Admin or Super Admin.
 * The holder's obligation ends with it: the event keeps who held it. An issued item is returned (or reported lost) first.
 */
export function retireItem(rc: RequestContext, i: RetireItemInput): Promise<Result<MoveOut>> {
  return runCommand(rc, async c => {
    const item = await loadItemLocked(c.tx, i.itemId)
    if (!item) return fail.notFound()
    const denied = authorizeAny(c, ['keys.manage'], item.siteId)
    if (denied) return denied
    if (item.status === 'retired') return ok(out(item, 'retired', null), 'Already retired')
    if (item.status === 'issued') return failure('conflict', `${label(item)} is still with its holder`, { owner: 'Reception', next: 'Record its return, or report it lost or damaged, then retire it', detail: { reason: 'issued', status: item.status } })
    const self = notSelf(c, item.holderStaffId, 'retire your own lost or damaged key or asset')
    if (self) return self
    await setState(c, item.id, { status: 'retired', holderStaffId: null, issuedAt: null, dueBack: null })
    await logEvent(c, { itemId: item.id, kind: 'retired', staffId: item.holderStaffId, note: i.reason })
    await audit(c, { action: 'keys.item.retired', entityType: 'handover_item', entityId: item.id, siteId: item.siteId, reason: i.reason, before: itemSnap(item), after: itemSnap({ ...item, status: 'retired', holderStaffId: null }) })
    const closed = item.holderStaffId ? await closeStaysOf(c, item.holderStaffId) : []
    return ok(out(item, 'retired', null, closed), `${label(item)} retired`)
  })
}

/* ---------------- replace ---------------- */

export const replaceInput = z.object({ itemId: idSchema, newCode: codeSchema, newItemType: itemTypeSchema.optional(), note: noteSchema })
export type ReplaceItemInput = z.infer<typeof replaceInput>
export interface ReplaceOut { oldId: string; newId: string; newCode: string; newStatus: 'in_cabinet' | 'issued'; holderStaffId: string | null; closedStays: string[]; message: string }

/**
 * A lost or damaged item is replaced (D-73): the new item is created at the same site with the same links, the old one is
 * retired and points to it (`replaced_by`), and if the old one had a holder who can still hold it, the new one is issued to
 * the same person. Events `replaced` (old) and `issued` (new) are written. All or nothing.
 */
export function replaceItem(rc: RequestContext, i: ReplaceItemInput): Promise<Result<ReplaceOut>> {
  return runCommand(rc, async c => {
    const old = await loadItemLocked(c.tx, i.itemId)
    if (!old) return fail.notFound()
    const denied = authorizeAny(c, ['keys.manage'], old.siteId)
    if (denied) return denied
    if (old.status !== 'lost' && old.status !== 'damaged') {
      return failure('conflict', `${label(old)} is ${old.status.replace('_', ' ')}: only a lost or damaged item is replaced`, {
        owner: 'Accommodation Admin', next: old.status === 'issued' ? 'Report it lost or damaged first' : 'Nothing to replace', detail: { reason: 'not_replaceable', status: old.status },
      })
    }
    const self = notSelf(c, old.holderStaffId, 'replace your own lost or damaged key or asset')
    if (self) return self
    const type = i.newItemType ?? old.itemType
    const bad = await itemTypeFailure(c.tx, old.category, type)
    if (bad) return bad
    const links = await resolveLinks(c.tx, old.siteId, old.roomId, old.bedId)
    if ('ok' in links) return links

    // Does the old holder still qualify? A former employee, or someone who moved on, does not get the new key: it goes to the cabinet.
    let holder = old.holderStaffId ? await staffRow(c.tx, old.holderStaffId, 'share') : undefined
    if (holder && (await holdabilityProblem(c.tx, old, holder, holder.id))) holder = undefined

    const made = await guardUnique(c.tx, q => q.insert(handoverItem).values({
      category: old.category, itemType: type, code: i.newCode, siteId: old.siteId, roomId: links.roomId, bedId: links.bedId,
      status: holder ? 'issued' : 'in_cabinet', holderStaffId: holder?.id ?? null, issuedAt: holder ? c.now : null, dueBack: holder ? old.dueBack : null,
      note: `Replaces ${old.code} (${old.status})`, createdAt: c.now, updatedAt: c.now,
    }).returning())
    if (!made) return duplicate('newCode', `There is already a ${old.category} with code "${i.newCode}" at this site`, 'Use a different code. The retired item keeps its own code until it is archived')
    const created = made[0]

    await setState(c, old.id, { status: 'retired', holderStaffId: null, issuedAt: null, dueBack: null }, { replacedBy: created.id })
    await logEvent(c, { itemId: old.id, kind: 'replaced', staffId: old.holderStaffId, note: [`Replaced by ${created.code}`, i.note].filter(Boolean).join('. ') })
    if (holder) await logEvent(c, { itemId: created.id, kind: 'issued', staffId: holder.id, note: `Replacement for ${old.code}` })
    await audit(c, { action: 'keys.item.created', entityType: 'handover_item', entityId: created.id, siteId: created.siteId, reason: `Replaces ${old.code}`, after: itemSnap(created) })
    await audit(c, { action: 'keys.item.replaced', entityType: 'handover_item', entityId: old.id, siteId: old.siteId, reason: i.note ?? undefined, before: itemSnap(old), after: { ...itemSnap({ ...old, status: 'retired', holderStaffId: null, replacedBy: created.id }), replacedByCode: created.code, reissuedTo: holder?.id ?? null } })
    const closed = old.holderStaffId ? await closeStaysOf(c, old.holderStaffId) : []
    const message = holder ? `${old.code} retired. ${created.code} issued to ${who(holder)} in its place`
      : `${old.code} retired. ${created.code} is in the cabinet${old.holderStaffId ? ' (the holder cannot be given a new one: see their record)' : ''}`
    return ok({ oldId: old.id, newId: created.id, newCode: created.code, newStatus: holder ? 'issued' as const : 'in_cabinet' as const, holderStaffId: holder?.id ?? null, closedStays: closed, message }, message)
  })
}
