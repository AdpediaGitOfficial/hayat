/**
 * Reading clearance cases: the list (open first, overdue marked) and one case with its items read LIVE from the keys register,
 * its history (who did what, on whose behalf) and what the viewer may do, with a reason + owner + next action when they may not.
 * Out of scope reads as not found. A case with no site (the person had no stay or reservation) is visible to any holder of the action
 * with a usable scope (S-8: the staff directory has no site column).
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { site, staffProfile, userAccount } from '@/server/db/schema'
import { clearanceCase, clearanceEvent, clearanceItem, type ClearanceItemStatus, type ClearanceOwner, type ClearanceStatus } from '@/server/db/schema.exit'
import type { Db } from '@/server/db/client'
import { decide, scopeFilter, type Action, type Actor } from '@/server/policy'
import { likePattern } from '@/server/queries/staff/access'
import { listAttachments } from '@/server/attachments'
import { loadCalendar } from '@/server/eligibility'
import { outstandingHandovers } from '@/server/handover/outstanding'
import { OWNER_LABEL, closeBlockers, deriveCaseStatus, nextActionFor, businessDaysAfter, type Blocker } from '@/server/commands/exit/rules'
import { caseItems, exitStay, handoverLabel, itemOwnerDenied, itemTypeLabels, resolveItems, todayInZone, type StaySummary } from '@/server/commands/exit/shared'
import { getConfig } from '@/server/config/registry'
import { bed, room } from '@/server/db/schema'

type Reader = Pick<Db, 'select'>

/** The WHERE fragment for the cases this actor may see. */
function visibleCases(actor: Actor): SQL | undefined {
  const f = scopeFilter(actor, 'exit_clearance.view')
  if (f.kind === 'all') return undefined
  if (f.kind === 'none') return sql`false`
  if (f.siteIds.length === 0) return sql`false`
  return or(inArray(clearanceCase.siteId, [...f.siteIds]), isNull(clearanceCase.siteId))
}

export interface CaseListItem {
  id: string
  staffId: string
  employeeId: string
  fullName: string
  siteId: string | null
  siteName: string | null
  status: ClearanceStatus
  effectiveDate: string
  dueDate: string
  openedAt: string
  clearedAt: string | null
  overdue: boolean
  daysOverdue: number
  /** Mandatory items not yet Done or Waived. */
  pendingMandatory: number
  totalItems: number
  /** Who has the next move, or null when nothing is pending. */
  nextOwner: string | null
  nextItem: string | null
}

export interface ListParams { q?: string; scope?: 'open' | 'cleared' | 'all'; overdueOnly?: boolean; limit?: number; now: Date }

export async function listCases(db: Reader, actor: Actor, p: ListParams): Promise<CaseListItem[]> {
  const q = (p.q ?? '').trim()
  const scope = p.scope ?? 'open'
  const where = and(
    visibleCases(actor),
    scope === 'open' ? sql`${clearanceCase.status} <> 'cleared'` : scope === 'cleared' ? eq(clearanceCase.status, 'cleared') : undefined,
    q ? or(ilike(staffProfile.fullName, likePattern(q)), ilike(staffProfile.employeeId, likePattern(q))) : undefined,
  )
  const rows = await db.select({
    id: clearanceCase.id, staffId: clearanceCase.staffId, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, siteId: clearanceCase.siteId, siteName: site.name, tz: site.timeZone,
    status: clearanceCase.status, effectiveDate: clearanceCase.effectiveDate, dueDate: clearanceCase.dueDate, openedAt: clearanceCase.openedAt, clearedAt: clearanceCase.clearedAt,
  }).from(clearanceCase).innerJoin(staffProfile, eq(staffProfile.id, clearanceCase.staffId)).leftJoin(site, eq(site.id, clearanceCase.siteId))
    .where(where)
    .orderBy(sql`(${clearanceCase.status} = 'cleared')`, asc(clearanceCase.dueDate), desc(clearanceCase.openedAt))
    .limit(Math.min(p.limit ?? 100, 300))
  const itemsByCase = new Map<string, ReturnType<typeof resolveItems>>()
  for (const r of rows) itemsByCase.set(r.id, resolveItems(await caseItems(db, r.id), r.staffId))
  const out: CaseListItem[] = rows.map(r => {
    const items = itemsByCase.get(r.id) ?? []
    const open = r.status !== 'cleared'
    const today = todayInZone(p.now, r.tz ?? 'UTC')
    const overdue = open && today > r.dueDate
    const pending = items.filter(i => i.mandatory && (i.effective === 'open' || i.effective === 'outstanding'))
    const first = pending.find(i => i.effective === 'outstanding') ?? pending[0]
    return {
      id: r.id, staffId: r.staffId, employeeId: r.employeeId, fullName: r.fullName, siteId: r.siteId, siteName: r.siteName,
      status: r.status === 'cleared' ? 'cleared' : deriveCaseStatus(items), effectiveDate: r.effectiveDate, dueDate: r.dueDate,
      openedAt: r.openedAt.toISOString(), clearedAt: r.clearedAt?.toISOString() ?? null,
      overdue, daysOverdue: overdue ? Math.round((Date.parse(today) - Date.parse(r.dueDate)) / 86_400_000) : 0,
      pendingMandatory: open ? pending.length : 0, totalItems: items.length,
      nextOwner: open && first ? OWNER_LABEL[first.effectiveOwnerRole] : null, nextItem: open && first ? first.label : null,
    }
  })
  const filtered = p.overdueOnly ? out.filter(o => o.overdue) : out
  // Open first, overdue before not overdue, then the earliest due date.
  return filtered.sort((a, b) => Number(a.status === 'cleared') - Number(b.status === 'cleared') || Number(b.overdue) - Number(a.overdue) || a.dueDate.localeCompare(b.dueDate))
}

/* ---------------- one case ---------------- */

export interface ItemAbility { canWork: boolean; canWaive: boolean; canReopen: boolean; why?: string; owner?: string; next?: string }
export interface ItemView {
  id: string
  kind: 'checklist' | 'handover'
  label: string
  mandatory: boolean
  owner: ClearanceOwner
  ownerLabel: string
  stored: ClearanceItemStatus
  status: ClearanceItemStatus
  note: string | null
  doneByName: string | null
  doneAt: string | null
  onBehalfOfName: string | null
  waiver: { byName: string | null; at: string | null; reason: string; evidence: string } | null
  handover: { code: string; status: string; category: 'key' | 'asset' } | null
  /**
   * A waived key or asset that is STILL lost, damaged or issued in the keys register (P-06 off: the waiver does not write it off).
   * It keeps the stay open until Keys & assets retires or replaces it.
   */
  keyOpenAfterWaiver: { code: string; status: string; owner: string; next: string } | null
  lostOrDamaged: boolean
  next: string | null
  attachments: { id: string; filename: string; contentType: string; sizeBytes: number; createdAt: string; href: string }[]
  me: ItemAbility
}
export interface EventView { id: string; at: string; kind: string; itemId: string | null; itemLabel: string | null; actorName: string | null; onBehalfOfName: string | null; note: string | null }
export interface CaseView {
  id: string
  status: ClearanceStatus
  effectiveDate: string
  reason: string
  openedAt: string
  openedByName: string | null
  dueDate: string
  overdue: boolean
  daysOverdue: number
  clearedAt: string | null
  clearedByName: string | null
  siteId: string | null
  siteName: string | null
  person: { staffId: string; employeeId: string; fullName: string; department: string | null; employmentStatus: 'active' | 'left'; accountStatus: string | null }
  stay: (StaySummary & { stillInBed: boolean }) | null
  items: ItemView[]
  /** Keys and assets the person holds now that are not on the case yet (they join when the case is next worked or closed). */
  notYetOnCase: { code: string; label: string; status: string }[]
  closeBlockers: Blocker[]
  /** The proposed rules in force for this case (pending client sign-off), so the screen can say who owns which item and what a waiver does to a key. */
  rules: { strictItemOwners: boolean; waiverWritesOffKey: boolean }
  events: EventView[]
  me: { canClose: boolean; canView: boolean; why?: string; owner?: string; next?: string; canWaiveAny: boolean }
}

const can = (actor: Actor, action: Action, siteId: string | null) => (siteId ? decide(actor, action, { siteId }).allowed : decide(actor, action).allowed && scopeFilter(actor, action).kind !== 'none')

export async function getCase(db: Reader, actor: Actor, id: string, now: Date): Promise<CaseView | undefined> {
  const [k] = await db.select().from(clearanceCase).where(eq(clearanceCase.id, id)).limit(1)
  if (!k || !can(actor, 'exit_clearance.view', k.siteId)) return undefined
  const [person] = await db.select({
    staffId: staffProfile.id, employeeId: staffProfile.employeeId, fullName: staffProfile.fullName, department: staffProfile.department, employmentStatus: staffProfile.employmentStatus, accountStatus: userAccount.status,
  }).from(staffProfile).leftJoin(userAccount, eq(userAccount.staffId, staffProfile.id)).where(eq(staffProfile.id, k.staffId)).limit(1)
  const [siteRow] = k.siteId ? await db.select({ name: site.name, tz: site.timeZone }).from(site).where(eq(site.id, k.siteId)).limit(1) : []
  const today = todayInZone(now, siteRow?.tz ?? 'UTC')
  const names = async (userIds: (string | null)[]) => {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))]
    if (ids.length === 0) return new Map<string, string>()
    const rows = await db.select({ id: userAccount.id, name: staffProfile.fullName }).from(userAccount).leftJoin(staffProfile, eq(staffProfile.id, userAccount.staffId)).where(inArray(userAccount.id, ids))
    return new Map(rows.map(r => [r.id, r.name ?? 'A colleague']))
  }
  const staffNames = async (staffIds: (string | null)[]) => {
    const ids = [...new Set(staffIds.filter((x): x is string => !!x))]
    if (ids.length === 0) return new Map<string, string>()
    const rows = await db.select({ id: staffProfile.id, name: staffProfile.fullName }).from(staffProfile).where(inArray(staffProfile.id, ids))
    return new Map(rows.map(r => [r.id, r.name]))
  }

  const items = resolveItems(await caseItems(db, k.id), k.staffId)
  const events = await db.select().from(clearanceEvent).where(eq(clearanceEvent.caseId, k.id)).orderBy(asc(clearanceEvent.seq))
  const userNames = await names([k.openedBy, k.clearedBy, ...items.flatMap(i => [i.doneBy, i.waivedBy]), ...events.map(e => e.actorUserId)])
  const personNames = await staffNames([...items.map(i => i.onBehalfOfStaffId), ...events.map(e => e.onBehalfOfStaffId)])

  const isOpen = k.status !== 'cleared'
  const self = actor.staffId === k.staffId
  const strict = await getConfig(db, 'clearance.strict_item_owners', k.siteId ?? undefined)           // P-07 (proposed, pending client sign-off)
  const writesOff = await getConfig(db, 'clearance.waiver_writes_off_key', k.siteId ?? undefined)    // P-06 (proposed, pending client sign-off)
  const itemViews: ItemView[] = []
  for (const i of items) {
    const waivable = isOpen && i.effective !== 'done' && i.effective !== 'waived'
    const owner = i.effectiveOwnerRole
    let me: ItemAbility
    if (!isOpen) me = { canWork: false, canWaive: false, canReopen: false, why: 'The case is cleared and cannot change', owner: 'Accommodation Admin', next: 'A new exit opens a new case' }
    else if (self) me = { canWork: false, canWaive: false, canReopen: false, why: 'Nobody works their own clearance (D-26)', owner: 'Another admin', next: 'Ask a colleague' }
    else {
      const ownerDenied = itemOwnerDenied({ actor }, i.owner, k.siteId, strict)
      const canWork = i.kind === 'checklist' && i.effective !== 'done' && i.effective !== 'waived' && !ownerDenied
      const canWaive = waivable && can(actor, 'exit_clearance.waive', k.siteId)
      const canReopen = i.kind === 'checklist' && (i.effective === 'done' || i.effective === 'outstanding') && i.status !== 'waived' && can(actor, 'exit_clearance.manage_case', k.siteId)
      let why: string | undefined, whyOwner: string | undefined, next: string | undefined
      if (!canWork && !canWaive && !canReopen && i.effective !== 'done' && i.effective !== 'waived') {
        if (i.kind === 'handover') { why = i.lostOrDamaged ? 'A lost or damaged key is never marked returned (D-73)' : 'Keys and assets are completed by recording the return'; whyOwner = OWNER_LABEL[owner]; next = nextActionFor({ ...i, kind: 'handover' }) }
        else if (ownerDenied && ownerDenied.code === 'forbidden' && ownerDenied.detail) { why = ownerDenied.reason; whyOwner = ownerDenied.owner; next = ownerDenied.next }
        else { why = i.owner === 'Maintenance' ? 'Only the Maintenance Coordinator completes inspection items' : 'Only Reception, an Accommodation Admin or a Super Admin work clearance items'; whyOwner = OWNER_LABEL[owner]; next = 'Ask them, or ask a Policy Approver to waive it' }
      }
      me = { canWork, canWaive, canReopen, why, owner: whyOwner, next }
    }
    const atts = await listAttachments(db, actor, 'clearance_item', i.id)
    itemViews.push({
      id: i.id, kind: i.kind, label: i.label, mandatory: i.mandatory, owner, ownerLabel: OWNER_LABEL[owner], stored: i.status, status: i.effective, note: i.note,
      doneByName: i.doneBy ? userNames.get(i.doneBy) ?? null : null, doneAt: i.doneAt?.toISOString() ?? null,
      onBehalfOfName: i.onBehalfOfStaffId ? personNames.get(i.onBehalfOfStaffId) ?? null : null,
      waiver: i.status === 'waived' ? { byName: i.waivedBy ? userNames.get(i.waivedBy) ?? null : null, at: i.waivedAt?.toISOString() ?? null, reason: i.waiverReason ?? '', evidence: i.waiverEvidence ?? '' } : null,
      handover: i.live ? { code: i.live.code, status: i.live.status, category: i.live.category } : null,
      keyOpenAfterWaiver: i.status === 'waived' && i.kind === 'handover' && i.live && ['issued', 'lost', 'damaged'].includes(i.live.status) && i.live.holderStaffId === k.staffId
        ? { code: i.live.code, status: i.live.status, owner: OWNER_LABEL.AA, next: `Retire or replace ${i.live.code} in Keys & assets. The stay stays open until then` }
        : null,
      lostOrDamaged: i.lostOrDamaged,
      next: isOpen && (i.effective === 'open' || i.effective === 'outstanding') ? nextActionFor({ ...i, kind: i.kind }) : null,
      attachments: atts.map(a => ({ id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: a.createdAt.toISOString(), href: `/api/v1/attachments/${a.id}` })),
      me,
    })
  }

  const held = isOpen ? await outstandingHandovers(db, k.staffId) : []
  const onCase = new Set(items.map(i => i.handoverItemId))
  const labels = await itemTypeLabels(db)
  const notYetOnCase = held.filter(h => !onCase.has(h.id)).map(h => ({ code: h.code, label: handoverLabel(labels, h), status: h.status }))

  const stay = await exitStay(db, k.staffId)
  let stayView: CaseView['stay'] = null
  if (stay) {
    const [rm] = await db.select({ room: room.name }).from(bed).innerJoin(room, eq(room.id, bed.roomId)).where(eq(bed.id, stay.bedId)).limit(1)
    stayView = { ...stay, roomName: rm?.room, stillInBed: stay.status !== 'checked_out' && stay.status !== 'closed' }
  }

  const blockers = isOpen ? closeBlockers(items.map(i => ({ id: i.id, label: i.label, kind: i.kind, mandatory: i.mandatory, effective: i.effective, owner: i.effectiveOwnerRole, lostOrDamaged: i.lostOrDamaged }))) : []
  const canManage = can(actor, 'exit_clearance.manage_case', k.siteId) && !self
  const itemLabel = new Map(items.map(i => [i.id, i.label]))

  return {
    id: k.id, status: k.status === 'cleared' ? 'cleared' : deriveCaseStatus(items), effectiveDate: k.effectiveDate, reason: k.reason, openedAt: k.openedAt.toISOString(), openedByName: userNames.get(k.openedBy) ?? null,
    dueDate: k.dueDate, overdue: isOpen && today > k.dueDate, daysOverdue: isOpen && today > k.dueDate ? businessDaysAfter(k.dueDate, today, await loadCalendar(db, k.siteId ?? undefined)) : 0,
    clearedAt: k.clearedAt?.toISOString() ?? null, clearedByName: k.clearedBy ? userNames.get(k.clearedBy) ?? null : null,
    siteId: k.siteId, siteName: siteRow?.name ?? null, person: person!, stay: stayView, items: itemViews, notYetOnCase, closeBlockers: blockers,
    rules: { strictItemOwners: strict, waiverWritesOffKey: writesOff },
    events: events.map(e => ({
      id: e.id, at: e.createdAt.toISOString(), kind: e.kind, itemId: e.itemId, itemLabel: e.itemId ? itemLabel.get(e.itemId) ?? null : null,
      actorName: e.actorUserId ? userNames.get(e.actorUserId) ?? null : null, onBehalfOfName: e.onBehalfOfStaffId ? personNames.get(e.onBehalfOfStaffId) ?? null : null, note: e.note,
    })),
    me: {
      canView: true, canClose: isOpen && canManage && blockers.length === 0, canWaiveAny: isOpen && !self && can(actor, 'exit_clearance.waive', k.siteId),
      ...(isOpen && !canManage ? { why: self ? 'Nobody closes their own clearance (D-26)' : 'Only an Accommodation Admin or a Super Admin closes a case', owner: 'Accommodation Admin', next: 'Ask an Accommodation Admin of this site' } : {}),
    },
  }
}
