import type { Bed, Persona, State } from './types'
import { approvalClock, bedById, can, eligibility, inScope, isPA, roomOf, staffById } from './rules'
import { today } from './time'

export const visibleSites = (s: State, p: Persona) => s.sites.filter(x => inScope(p, x.id))
export const bedsInScope = (s: State, p: Persona, site?: string) =>
  s.beds.filter(b => b.state !== 'Archived' && inScope(p, b.siteId) && (!site || site === 'all' || b.siteId === site))

/** Bed-status buckets used by the occupancy bar (fixed colour mapping). */
export function occupancy(s: State, beds: Bed[]) {
  let occupied = 0, reserved = 0, available = 0, blocked = 0
  const booked = new Set(s.reservations.filter(r => r.status === 'Reserved').map(r => r.bedId))
  for (const b of beds) {
    if (b.state === 'Occupied') occupied++
    else if (b.state === 'Blocked' || b.state === 'UnderMaintenance' || b.state === 'NeedsCleaning' || b.state === 'InspectionRequired') blocked++
    else if (b.heldBy || booked.has(b.id)) reserved++
    else available++
  }
  return { occupied, reserved, available, blocked, total: beds.length }
}

export type ApprovalKind = 'Request' | 'Transfer' | 'Swap' | 'Extension' | 'Emergency' | 'Migration' | 'Work order'
export type ApprovalItem = {
  key: string; kind: ApprovalKind; ref: string; title: string; sub: string; createdAt: number
  primary: string; backup: string; current: string; level: 0 | 1 | 2; reminders: number; label: string
  mine: boolean; why?: string; urgent?: boolean; deadline?: number
}

function roleCanAct(p: Persona, route: 'AA' | 'PA' | 'MC' | 'PA/SA', level: 0 | 1 | 2) {
  const aa = p.role === 'AA' || p.role === 'SA'
  if (route === 'AA') return (p.role === 'AA') || (level >= 1 && (p.caps.includes('BackupApprover') || isPA(p))) || (level >= 2 && p.role === 'SA')
  if (route === 'PA') return isPA(p) || (level >= 1 && p.caps.includes('BackupApprover')) || (level >= 2 && p.role === 'SA')
  if (route === 'MC') return p.role === 'MC' || (level >= 1 && p.role === 'AA')
  return isPA(p) || p.role === 'SA' || aa && false
}

/** One approval inbox pattern across all modules (D-95): route, current approver, SLA, reminders, escalation, and why you can't approve. */
export function approvalInbox(s: State, p: Persona, now: number): ApprovalItem[] {
  const items: ApprovalItem[] = []
  const cfg = s.config
  const self = (staffId: string) => !!p.staffId && p.staffId === staffId
  const levelName = (lvl: number, primary: string, backup: string) => lvl === 0 ? primary : lvl === 1 ? `${backup} (backup)` : 'Policy Approver / Super Admin'
  for (const q of s.requests.filter(x => x.status === 'Submitted')) {
    const staff = staffById(s, q.staffId)!
    const clk = approvalClock(q.createdAt, now, cfg)
    const urgent = (Date.parse(q.arrival) - now) / 86400000 <= cfg.slaBusinessDays + 1
    let mine = roleCanAct(p, 'AA', clk.level), why: string | undefined
    if (self(q.staffId)) { mine = false; why = 'You can’t approve your own request. Auto-routed to an independent approver (backup, then Policy Approver)' }
    else if (!mine) why = p.role === 'AA' ? undefined : 'Only an Accommodation Admin decides standard requests'
    items.push({ key: q.id, kind: 'Request', ref: q.id, title: `${staff.name}: accommodation request`, sub: `${q.stayType} · arrives ${q.arrival} · ${staff.dept}${q.onBehalf ? ' · entered by Reception' : ''}`, createdAt: q.createdAt, primary: 'Accommodation Admin', backup: 'Policy Approver',
      current: self(q.staffId) ? 'Backup approver → Policy Approver (self-approval blocked)' : levelName(clk.level, 'Accommodation Admin', 'Policy Approver'), level: clk.level, reminders: clk.reminders, label: clk.label, mine, why, urgent })
  }
  for (const t of s.transfers.filter(x => x.status === 'Submitted')) {
    const st = s.stays.find(x => x.id === t.stayId)!
    const other = t.otherStayId ? s.stays.find(x => x.id === t.otherStayId) : undefined
    const clk = approvalClock(t.createdAt, now, cfg)
    let mine = roleCanAct(p, 'AA', clk.level), why: string | undefined
    if (self(st.staffId) || (other && self(other.staffId)) || p.staffId === t.requestedBy) { mine = false; why = 'You can’t approve a transfer you raised or are part of' }
    items.push({ key: t.id, kind: t.kind, ref: t.id, title: t.kind === 'Swap' ? `${staffById(s, st.staffId)!.name} ⇄ ${staffById(s, other!.staffId)!.name}: bed swap` : `${staffById(s, st.staffId)!.name}: transfer to ${bedById(s, t.destBedId)?.code}`,
      sub: t.reason, createdAt: t.createdAt, primary: 'Accommodation Admin', backup: 'Policy Approver', current: levelName(clk.level, 'Accommodation Admin', 'Policy Approver'), level: clk.level, reminders: clk.reminders, label: clk.label, mine, why })
  }
  for (const x of s.extensions.filter(e => e.status === 'Submitted')) {
    const st = s.stays.find(y => y.id === x.stayId)!
    const clk = approvalClock(x.createdAt, now, cfg)
    const route = x.beyondPolicy ? 'PA' : 'AA'
    let mine = roleCanAct(p, route, clk.level), why: string | undefined
    if (self(st.staffId) || p.staffId === x.requestedBy) { mine = false; why = 'You can’t approve your own extension' }
    else if (!mine && x.beyondPolicy) why = 'Beyond policy: only the Policy Approver (or named backup) decides'
    items.push({ key: x.id, kind: 'Extension', ref: x.id, title: `${staffById(s, st.staffId)!.name}: extend stay to ${x.newEnd}`, sub: `${x.beyondPolicy ? 'Beyond policy · ' : ''}${x.reason}`, createdAt: x.createdAt, primary: x.beyondPolicy ? 'Policy Approver' : 'Accommodation Admin', backup: x.beyondPolicy ? 'Named backup' : 'Policy Approver',
      current: x.beyondPolicy ? 'Policy Approver' : levelName(clk.level, 'Accommodation Admin', 'Policy Approver'), level: clk.level, reminders: clk.reminders, label: clk.label, mine, why })
  }
  for (const m of s.emergencies.filter(e => e.status === 'Pending')) {
    const staff = staffById(s, m.staffId)!
    const cur = m.escalation === 0 ? (m.approverRole === 'AA' ? 'Accommodation Admin' : 'Policy Approver') : m.escalation === 1 ? 'Backup approver' : 'Policy Approver / Super Admin'
    let mine: boolean
    if (m.escalation === 0) mine = m.approverRole === 'AA' ? p.role === 'AA' : isPA(p)
    else if (m.escalation === 1) mine = p.caps.includes('BackupApprover') || isPA(p)
    else mine = isPA(p) || p.role === 'SA'
    let why: string | undefined
    if (p.id === m.initiatorId || self(m.staffId)) { mine = false; why = 'You initiated this emergency check-in. The approver must be someone else' }
    else if (!mine) why = `Currently routed to ${cur}`
    items.push({ key: m.id, kind: 'Emergency', ref: m.id, title: `${staff.name}: emergency check-in`, sub: m.reason, createdAt: m.createdAt, primary: m.approverRole === 'AA' ? 'Accommodation Admin' : 'Policy Approver', backup: 'Backup approver', current: cur,
      level: m.escalation, reminders: m.reminders, label: m.escalation === 2 ? 'Critical' : m.escalation === 1 ? 'Escalated' : m.reminders ? 'Reminded' : 'Within 24h', mine, why, urgent: true, deadline: m.createdAt + cfg.emergencyDeadlineHours * 3600_000 * (m.reminders + 1) })
  }
  if (s.migration?.status === 'Prepared') {
    const mine = isPA(p) || p.role === 'SA'
    items.push({ key: s.migration.id, kind: 'Migration', ref: s.migration.id, title: 'Import Current Occupancy: sign-off', sub: `${s.migration.rows.filter(r => !r.error).length} valid rows prepared by ${s.migration.preparedBy}`, createdAt: Date.parse(today() + 'T00:00:00Z'), primary: 'Policy Approver / SA', backup: 'Second SA', current: 'Policy Approver / SA (checker)', level: 0, reminders: 0, label: 'Awaiting checker', mine: mine && s.migration.preparedBy !== p.name, why: mine ? 'The maker can’t be the checker' : 'Only a Policy Approver or Super Admin signs off' })
  }
  for (const w of s.workOrders.filter(x => x.status === 'Resolved')) {
    const bed = bedById(s, w.bedId)!
    const mine = (p.role === 'MC' || p.role === 'AA') && w.resolvedBy !== p.staffId
    items.push({ key: w.id, kind: 'Work order', ref: w.id, title: `Verify: ${w.title}`, sub: `${bed.code} · resolved by ${staffById(s, w.resolvedBy)?.name ?? w.resolvedBy}`, createdAt: w.createdAt, primary: 'Maintenance Coordinator', backup: 'Accommodation Admin', current: 'Maintenance Coordinator', level: 0, reminders: 0, label: 'Resolved ≠ Verified', mine, why: mine ? undefined : 'An independent verifier signs off: the person who resolved it can’t' })
  }
  return items.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || b.level - a.level || a.createdAt - b.createdAt)
}
export const myInbox = (s: State, p: Persona, now: number) => approvalInbox(s, p, now).filter(i => i.mine)

export function myStatus(s: State, staffId: string) {
  const stay = s.stays.find(x => x.staffId === staffId && x.status === 'Active')
  const offer = s.offers.find(o => o.staffId === staffId && o.status === 'Pending')
  const entry = s.waitlist.find(w => w.staffId === staffId && w.status !== 'Closed')
  const res = s.reservations.find(r => r.staffId === staffId && r.status === 'Reserved')
  const req = s.requests.find(r => r.staffId === staffId && r.status === 'Submitted')
  const status = stay ? (stay.checkoutRequested ? 'checking-out' : 'staying') : offer ? 'offered' : res ? 'reserved' : entry ? 'waitlisted' : req ? 'applied' : 'none'
  return { status, stay, offer, entry, res, req } as const
}

export const eligibleBedsFor = (s: State, staffId: string, p: Persona) => {
  const staff = staffById(s, staffId)!
  return s.beds.filter(b => inScope(p, b.siteId) && b.state !== 'Archived').filter(b => eligibility(s, staff, b).ok)
}

export const notificationsFor = (s: State, p: Persona) =>
  s.notifications.filter(n => (n.toStaffId && n.toStaffId === p.staffId) || (n.toRole && (n.toRole === p.role || (n.toRole === 'PA' && isPA(p))))).slice(0, 30)

export const roomGenderLabel = (s: State, bed: Bed) => roomOf(s, bed).gender
export { can }
