/* Scoped reads. In the production build every read goes through the same policy and scope filter as writes (AT-001, AT-002, AT-031).
   Out-of-scope records come back as "not found", never "forbidden", so nothing leaks. */
import type { Persona, Res, Staff, State, WorkOrder } from './types'
import { activeStayOfStaff, bedById, can, hasRole, inScope, openReservationOfStaff, roomOf, staffById } from './rules'
import { contractorAccess } from './ext/security'

export type StaffView = { id: string; name: string; dept: string; phone: string; status: Staff['status']; hasPhoto: boolean; bedCode?: string; roomName?: string; grade?: number; gender?: string; email?: string; emergencyContact?: string; verified?: boolean }
const notFound = <T,>(): Res<T> => ({ ok: false, reason: 'Not found', owner: 'System', next: 'Check the identifier, or ask an admin' })
const mask = (p: string) => '•••• ' + p.slice(-4)

/** The site a staff member is tied to right now (current stay, else reservation). Unplaced staff belong to no site yet. */
export function staffSite(d: State, staffId: string): string | undefined {
  const st = activeStayOfStaff(d, staffId)
  if (st) return bedById(d, st.bedId)?.siteId
  const r = openReservationOfStaff(d, staffId)
  return r ? bedById(d, r.bedId)?.siteId : undefined
}

export function readStaff(d: State, actor: Persona, id: string): Res<StaffView> {
  const s = staffById(d, id)
  if (!s || actor.revoked) return notFound()
  const st = activeStayOfStaff(d, s.id)
  const bed = st ? bedById(d, st.bedId) : undefined
  const site = staffSite(d, s.id)
  const base = { id: s.id, name: s.name, dept: s.dept, status: s.status, hasPhoto: !!s.hasPhoto }
  // own record
  if (actor.staffId === s.id) return { ok: true, data: { ...base, phone: s.phone, grade: s.grade, gender: s.gender, email: s.email, emergencyContact: s.emergencyContact, bedCode: bed?.code } }
  if (hasRole(actor, 'Res') && !can(actor, 'staff.manage') && !hasRole(actor, 'Rec') && !hasRole(actor, 'AA')) return notFound()
  // administrators with the staff master: full data, within scope
  if (can(actor, 'staff.manage')) {
    if (site && !inScope(actor, site)) return notFound()
    return { ok: true, data: { ...base, phone: s.phone, grade: s.grade, gender: s.gender, email: s.email, emergencyContact: s.emergencyContact, verified: s.verified, bedCode: bed?.code } }
  }
  // reception: lookup with minimum data
  if (hasRole(actor, 'Rec')) {
    if (site && !inScope(actor, site)) return notFound()
    return { ok: true, data: { ...base, phone: mask(s.phone), bedCode: bed?.code } }
  }
  // security: identity check only (name, photo, room)
  if (hasRole(actor, 'Sec')) {
    const expected = st || openReservationOfStaff(d, s.id) || d.visitors.some(v => v.hostStaffId === s.id)
    if (!expected || (site && !inScope(actor, site))) return notFound()
    return { ok: true, data: { id: s.id, name: s.name, dept: '', phone: '', status: s.status, hasPhoto: !!s.hasPhoto, roomName: bed ? roomOf(d, bed).name : undefined } }
  }
  return notFound()
}
export const listStaff = (d: State, actor: Persona) =>
  d.staff.map(s => readStaff(d, actor, s.id)).flatMap(r => (r.ok && r.data ? [r.data] : []))

export function readWorkOrder(d: State, actor: Persona, id: string, now: number): Res<WorkOrder> {
  const w = d.workOrders.find(x => x.id === id)
  if (!w || actor.revoked) return notFound()
  const bed = bedById(d, w.bedId)!
  if (hasRole(actor, 'Vend')) return w.assignee === actor.vendor && contractorAccess(d, actor.vendor ?? '', id, now) === null ? { ok: true, data: w } : notFound()
  if (hasRole(actor, 'Tech')) return w.assignee === actor.staffId || !w.assignee ? { ok: true, data: w } : notFound()
  if (hasRole(actor, 'Res') && !hasRole(actor, 'MC') && !hasRole(actor, 'AA')) {
    const st = actor.staffId ? activeStayOfStaff(d, actor.staffId) : undefined
    return st && st.bedId === w.bedId ? { ok: true, data: w } : notFound()
  }
  return inScope(actor, bed.siteId) || actor.sites === 'all' ? { ok: true, data: w } : notFound()
}

export type ReportKind = 'occupancy' | 'stays' | 'arrivals'
/** Report rows limited to the actor's sites. Anything outside scope is excluded and counted, never shown. */
export function reportRows(d: State, actor: Persona, kind: ReportKind, siteIds?: string[]) {
  const inSites = (siteId: string) => inScope(actor, siteId) && (!siteIds || siteIds.includes(siteId))
  let excluded = 0
  const rows: string[][] = []
  if (kind === 'occupancy') {
    for (const b of d.beds) {
      if (b.state === 'Archived') continue
      if (!inSites(b.siteId)) { excluded++; continue }
      rows.push([b.siteId, b.code, b.state])
    }
    return { header: ['site', 'bed', 'state'], rows, excluded }
  }
  if (kind === 'stays') {
    for (const s of d.stays.filter(x => x.status === 'Active')) {
      const bed = bedById(d, s.bedId)!
      if (!inSites(bed.siteId)) { excluded++; continue }
      rows.push([s.staffId, staffById(d, s.staffId)?.name ?? '', bed.code, s.start, s.end ?? ''])
    }
    return { header: ['employee', 'name', 'bed', 'start', 'planned_end'], rows, excluded }
  }
  for (const r of d.reservations.filter(x => x.status === 'Reserved')) {
    const bed = bedById(d, r.bedId)!
    if (!inSites(bed.siteId)) { excluded++; continue }
    rows.push([r.staffId, staffById(d, r.staffId)?.name ?? '', bed.code, r.from])
  }
  return { header: ['employee', 'name', 'bed', 'arrival'], rows, excluded }
}
