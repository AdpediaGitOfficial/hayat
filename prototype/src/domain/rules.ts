import type { Bed, Building, Config, Fail, Persona, Reservation, Role, Room, Site, State, Staff, Stay } from './types'
import { businessDaysBetween, addDays, dateStr, DAY } from './time'
import { PERSONAS } from '../roles'

/* ---------------- lookups ---------------- */
export const staffById = (s: State, id?: string) => s.staff.find(x => x.id === id)
export const bedById = (s: State, id?: string) => s.beds.find(x => x.id === id)
export const roomOf = (s: State, bed: Bed): Room => s.rooms.find(r => r.id === bed.roomId)!
export const siteOf = (s: State, bed: Bed): Site => s.sites.find(x => x.id === bed.siteId)!
export const buildingOf = (s: State, room: Room): Building | undefined => s.buildings.find(b => b.id === room.buildingId)
export const activeStayOfStaff = (s: State, staffId: string) => s.stays.find(x => x.staffId === staffId && x.status === 'Active')
export const activeStayOfBed = (s: State, bedId: string) => s.stays.find(x => x.bedId === bedId && x.status === 'Active')
export const openReservationOfStaff = (s: State, staffId: string) => s.reservations.find(x => x.staffId === staffId && x.status === 'Reserved')

/** "Palm Villas › Villa 03 › Room 1 › Bed A" */
export function bedPath(s: State, bed: Bed) {
  const room = roomOf(s, bed), b = buildingOf(s, room), site = siteOf(s, bed)
  return [site.name, b?.name, room.floor, room.name, 'Bed ' + bed.code.split('-').pop()].filter(Boolean).join(' › ')
}

/* ---------------- permissions (Module × Action × Scope, enforced in the store) ---------------- */
export type Perm =
  | 'request.submit' | 'request.approve' | 'request.exception' | 'allocate.bulk' | 'checkin.execute' | 'checkout.execute' | 'checkout.request'
  | 'bed.manage' | 'bed.block' | 'building.create' | 'site.create' | 'offer.manage' | 'offer.respond' | 'waitlist.manage' | 'waitlist.exception'
  | 'transfer.request' | 'transfer.approve' | 'transfer.execute' | 'extension.request' | 'extension.approve' | 'extension.beyond'
  | 'exit.markLeft' | 'clearance.task' | 'clearance.waive' | 'housekeeping.assign' | 'housekeeping.clean' | 'inspect.final'
  | 'emergency.initiate' | 'emergency.approve' | 'emergency.backup' | 'emergency.policy' | 'staff.manage' | 'migration.prepare' | 'migration.signoff'
  | 'key.manage' | 'incident.ack' | 'sos.raise' | 'workorder.create' | 'workorder.manage' | 'workorder.work' | 'workorder.verify' | 'config.edit' | 'delegate.set'
  | 'visitor.register' | 'visitor.approve' | 'visitor.gate' | 'contractor.manage' | 'contractor.gate' | 'outage.declare' | 'outage.export' | 'outage.reconcile'
  | 'rehire' | 'permission.request' | 'permission.decide' | 'account.reset.staff' | 'account.reset.admin' | 'structure.archive' | 'structure.block' | 'report.export' | 'notification.retry'

const ROLE_PERMS: Record<string, Perm[]> = {
  SA: ['bed.manage', 'bed.block', 'building.create', 'site.create', 'staff.manage', 'migration.signoff', 'config.edit', 'emergency.policy', 'delegate.set',
    'permission.request', 'permission.decide', 'account.reset.admin', 'account.reset.staff', 'structure.archive', 'structure.block', 'report.export', 'notification.retry', 'contractor.manage'],
  AA: ['request.submit', 'request.approve', 'allocate.bulk', 'checkin.execute', 'checkout.execute', 'bed.manage', 'bed.block', 'offer.manage', 'waitlist.manage',
    'transfer.request', 'transfer.approve', 'transfer.execute', 'extension.request', 'extension.approve', 'exit.markLeft', 'clearance.task', 'housekeeping.assign',
    'emergency.approve', 'staff.manage', 'migration.prepare', 'key.manage', 'workorder.create', 'delegate.set',
    'visitor.register', 'visitor.approve', 'contractor.manage', 'outage.declare', 'outage.reconcile', 'rehire', 'account.reset.staff', 'structure.archive', 'structure.block', 'report.export', 'notification.retry'],
  Rec: ['request.submit', 'checkin.execute', 'checkout.execute', 'offer.manage', 'transfer.execute', 'clearance.task', 'housekeeping.assign', 'key.manage', 'workorder.create',
    'visitor.register', 'visitor.approve'],
  Res: ['request.submit', 'checkout.request', 'offer.respond', 'transfer.request', 'extension.request', 'sos.raise', 'workorder.create'],
  MC: ['bed.block', 'clearance.task', 'workorder.manage', 'workorder.verify', 'workorder.create', 'contractor.manage'],
  Tech: ['workorder.work'], Vend: ['workorder.work'],
  Sec: ['incident.ack', 'sos.raise', 'visitor.gate', 'contractor.gate'], Mgr: [], Aud: [],
}
const CAP_PERMS: Record<string, Perm[]> = {
  Housekeeping: ['housekeeping.clean'], FinalInspection: ['inspect.final'], EmergencyCheckin: ['emergency.initiate'], BuildingCreation: ['building.create'],
  NightKeys: ['key.manage'], BackupApprover: ['emergency.backup', 'workorder.verify'], StaffMaster: ['staff.manage'],
  PolicyApprover: ['request.exception', 'waitlist.exception', 'extension.beyond', 'clearance.waive', 'migration.signoff', 'emergency.policy', 'emergency.backup'],
  OutageExport: ['outage.export'], ReportExport: ['report.export'],
}
export function can(p: Persona, perm: Perm) {
  if (p.revoked) return false   // Mark as Left or deactivation revokes the login immediately
  return ROLE_PERMS[p.role]?.includes(perm) || (p.extraRoles ?? []).some(r => ROLE_PERMS[r]?.includes(perm)) || p.caps.some(c => CAP_PERMS[c]?.includes(perm)) || false
}
export const hasRole = (p: Persona, r: Role) => !p.revoked && (p.role === r || (p.extraRoles ?? []).includes(r))

/** The persona as the server would see it right now: approved capability grants and role/scope changes applied,
    delegated authority from out-of-office approvers added (separation of duties still applies to the delegate), and login revoked if the account or the person has been deactivated. */
export function actingAs(s: State, base: Persona, now: number): Persona {
  const T = dateStr(now)
  const effective = (p: Persona): Persona => {
    const o = s.overrides[p.id]
    const caps = p.caps.filter(c => !o?.removeCaps.includes(c))
    o?.addCaps.forEach(g => { if ((!g.expires || g.expires >= T) && !caps.includes(g.cap)) caps.push(g.cap) })
    return { ...p, role: o?.role ?? p.role, caps, sites: o?.sites ?? p.sites }
  }
  const me = effective(base)
  const extraRoles: Role[] = [], delegatedFrom: string[] = []
  let sites = me.sites
  for (const d of s.delegations) {
    if (d.to !== base.name || d.fromDate > T || d.toDate < T) continue
    const from = PERSONAS.find(x => x.name === d.from)
    if (!from) continue
    const f = effective(from)
    delegatedFrom.push(f.name)
    if (f.role !== me.role && !extraRoles.includes(f.role)) extraRoles.push(f.role)
    f.caps.forEach(c => { if (!me.caps.includes(c)) me.caps.push(c) })
    sites = sites === 'all' || f.sites === 'all' ? 'all' : Array.from(new Set([...sites, ...f.sites]))
  }
  const staff = base.staffId ? s.staff.find(x => x.id === base.staffId) : undefined
  const revoked = (staff && !staff.loginActive) || s.accounts[base.id]?.active === false
  return { ...me, sites, extraRoles, delegatedFrom, revoked: !!revoked }
}
export const inScope = (p: Persona, siteId: string) => p.sites === 'all' || p.sites.includes(siteId)
export const isPA = (p: Persona) => p.caps.includes('PolicyApprover')

export function deny(p: Persona, perm: Perm, what: string): Fail | null {
  if (can(p, perm)) return null
  return { ok: false, reason: `${p.name} can't ${what}`, owner: 'Role permissions', next: 'Switch to a role that holds this permission, or ask a Super Admin to grant the capability' }
}
export function outOfScope(p: Persona, siteId: string): Fail | null {
  if (inScope(p, siteId)) return null
  return { ok: false, reason: `${siteId} is outside ${p.name}'s assigned sites`, owner: 'Super Admin', next: 'Only a Super Admin can change site scope. Capability grants never widen it' }
}
/** D-26 separation of duties: nobody acts on their own record. */
export function selfAction(p: Persona, staffId: string, what: string, owner = 'a Policy Approver'): Fail | null {
  if (p.staffId && p.staffId === staffId) {
    return { ok: false, reason: `You can't ${what} your own record`, owner: 'Separation of duties (D-26)', next: `Routed to an independent approver: backup approver, then ${owner}` }
  }
  return null
}

/* ---------------- eligibility ---------------- */
export type Eligibility = { ok: boolean; reasons: string[]; exceptionable: boolean }
export function eligibility(s: State, staff: Staff, bed: Bed): Eligibility {
  const reasons: string[] = []
  const room = roomOf(s, bed), site = siteOf(s, bed), cfg = s.config
  if (staff.status !== 'Active') reasons.push('Employment status is Left')
  if (cfg.genderStrict && room.gender !== 'Any' && room.gender !== staff.gender && !staff.exceptions.includes('gender'))
    reasons.push(`${room.name} is ${room.gender.toLowerCase()}-only (gender rule)`)
  const min = cfg.minGradeBySite[site.id] ?? site.minGrade
  if (staff.grade < min && !staff.exceptions.includes('grade')) reasons.push(`${site.name} needs grade G${min}+ (staff is G${staff.grade})`)
  const exceptionable = reasons.length > 0 && !reasons.includes('Employment status is Left')
  return { ok: reasons.length === 0, reasons, exceptionable }
}

/* ---------------- overlap: the bed is the allocation unit ---------------- */
type Window = { from: string; to?: string }
const overlaps = (a: Window, b: Window) => (!a.to || b.from <= a.to) && (!b.to || a.from <= b.to)
export function bedConflict(s: State, bedId: string, w: Window, ignore: { reservationId?: string; stayId?: string } = {}) {
  const st = s.stays.find(x => x.bedId === bedId && x.status === 'Active' && x.id !== ignore.stayId && overlaps(w, { from: x.start, to: x.end }))
  if (st) return { kind: 'stay' as const, stay: st, who: staffById(s, st.staffId)?.name ?? 'someone' }
  const rs = s.reservations.find(x => x.bedId === bedId && x.status === 'Reserved' && x.id !== ignore.reservationId && overlaps(w, { from: x.from, to: x.to }))
  if (rs) return { kind: 'reservation' as const, reservation: rs, who: staffById(s, rs.staffId)?.name ?? 'someone' }
  // date-ranged blocks (repair, safety, …) keep a bed out of use for the dates they cover
  const blk = (s.beds.find(b => b.id === bedId)?.blocks ?? []).find(k => overlaps(w, { from: k.from, to: k.to }))
  if (blk) return { kind: 'block' as const, who: `${blk.reason} (${blk.from} to ${blk.to ?? 'further notice'})` }
  return null
}
export function bedAllocatable(s: State, bed: Bed): Fail | null {
  const room = roomOf(s, bed), bld = buildingOf(s, room)
  if (room.archived || bld?.archived) return { ok: false, reason: `${room.archived ? room.name : bld!.name} is archived`, owner: 'Accommodation Admin', next: 'Choose a bed in an active room' }
  const hold = room.blocked ?? bld?.blocked
  if (hold) return { ok: false, reason: `${room.blocked ? room.name : bld!.name} is blocked: ${hold.reason}`, owner: 'Accommodation Admin', next: 'Unblock it or choose another bed. Existing residents are flagged, never moved automatically' }
  if (bed.heldBy) return { ok: false, reason: `${bed.code} is held by a bed offer`, owner: 'The offered resident', next: 'Wait for the offer to be accepted, declined or expire' }
  if (bed.state === 'Blocked' || bed.state === 'UnderMaintenance' || bed.state === 'Archived')
    return { ok: false, reason: `${bed.code} is ${bed.state === 'Archived' ? 'archived' : bed.state === 'Blocked' ? 'blocked' : 'under maintenance'}${bed.reason ? ': ' + bed.reason : ''}`, owner: 'Maintenance Coordinator', next: 'Unblock the bed or choose another' }
  return null
}

/** Beds suitable for a person and date window, best first. Needs-cleaning beds are allowed: readiness gates check-in, not reservation (D-18). */
export function suggestBeds(s: State, staff: Staff, w: Window, scope: Persona['sites'], ignore: { reservationId?: string } = {}) {
  return s.beds
    .filter(b => (scope === 'all' || scope.includes(b.siteId)))
    .filter(b => !bedAllocatable(s, b))
    .filter(b => eligibility(s, staff, b).ok)
    .filter(b => !bedConflict(s, b.id, w, ignore))
    .sort((a, b) => Number(a.state !== 'Available') - Number(b.state !== 'Available') || a.code.localeCompare(b.code))
}

/* ---------------- approvals clock (reminder at 1bd → backup at 2 → escalate at 3; never auto-decides) ---------------- */
export function approvalClock(createdAt: number, now: number, cfg: Config) {
  const bd = businessDaysBetween(createdAt, now)
  const sla = cfg.slaBusinessDays
  const reminders = bd >= 1 ? Math.min(bd, sla + 1) : 0
  const level: 0 | 1 | 2 = bd >= sla + 1 ? 2 : bd >= sla ? 1 : 0
  return { bd, reminders, level, label: level === 2 ? 'Escalated' : level === 1 ? 'Routed to backup' : reminders ? 'Reminded' : 'Within SLA' }
}

/* ---------------- stay helpers ---------------- */
export function stayState(st: Stay, today: string, cfg: Config): 'ok' | 'ending' | 'overdue' | 'escalated' {
  if (!st.end) return 'ok'
  const over = Math.round((Date.parse(today) - Date.parse(st.end)) / DAY)
  if (over > cfg.overdueGraceDays) return 'escalated'
  if (over >= 1) return 'overdue'
  return st.end <= addDays(today, 7) ? 'ending' : 'ok'
}
export const resStatusView = (r: Reservation, now: number, bed?: Bed): 'Expected' | 'Not ready' | 'No-show' => {
  if (now > r.eta) return 'No-show'
  if (bed && bed.state !== 'Available') return 'Not ready'
  return 'Expected'
}
