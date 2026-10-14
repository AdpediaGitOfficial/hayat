/* Network outage: watermarked snapshot export, offline log, and reconciliation after restoration (P-7), plus controlled exports.
   An export is a reference snapshot only: it never reserves a bed, and offline actions are never bulk-imported without validation (FPD §10.2). */
import type { OfflineEvent, Persona, State } from '../types'
import { fail, fullName, guard, log, notify, ok, openCleaning, run, setBed, uid } from '../core'
import { activeStayOfBed, activeStayOfStaff, bedById, can, deny, staffById } from '../rules'
import { reportRows, type ReportKind } from '../reads'
import { dateStr, fmtDateTime, nowMs } from '../time'

const csvCell = (v: string) => (/^[=+\-@]/.test(v) ? "'" + v : v).replace(/"/g, '""')
const toCsv = (watermark: string, header: string[], rows: string[][]) =>
  [watermark, header.join(','), ...rows.map(r => r.map(c => `"${csvCell(c)}"`).join(','))].join('\n')

/** Why an offline event can't simply be applied to the live records. Empty = clean. */
export function offlineConflict(d: State, ev: OfflineEvent): string | undefined {
  const staff = staffById(d, ev.staffId)
  const bed = d.beds.find(b => b.code === ev.bedCode)
  if (!staff) return 'Unknown employee'
  if (!bed) return `Unknown bed ${ev.bedCode}`
  if (ev.kind === 'arrival') {
    if (staff.status !== 'Active') return `${staff.name} has left the organisation`
    const own = activeStayOfStaff(d, staff.id)
    if (own) return `${staff.name} already has a stay in ${bedById(d, own.bedId)?.code}`
    const occ = activeStayOfBed(d, bed.id)
    if (occ) return `${bed.code} is now occupied by ${fullName(d, occ.staffId)}`
    const other = d.reservations.find(r => r.bedId === bed.id && r.status === 'Reserved' && r.staffId !== staff.id)
    if (other) return `${bed.code} is reserved for ${fullName(d, other.staffId)}`
    if (bed.state !== 'Available') return `${bed.code} is ${bed.state}`
    if (!d.reservations.some(r => r.bedId === bed.id && r.staffId === staff.id && r.status === 'Reserved')) return 'No reservation on record: normal check-in is blocked'
    return undefined
  }
  const st = activeStayOfStaff(d, staff.id)
  if (!st || st.bedId !== bed.id) return `${staff.name} has no active stay in ${bed.code}`
  return undefined
}

export const outageActions = {
  declareOutage(actor: Persona) {
    return run(d => {
      const e = guard(can(actor, 'outage.declare') || can(actor, 'outage.export') ? null : deny(actor, 'outage.declare', 'declare an outage'))
      if (e) return e
      if (d.outage && !d.outage.restoredAt) return fail('An outage is already declared')
      d.outage = { declaredAt: nowMs(), declaredBy: actor.name }
      log(d, actor, 'Outage declared', 'Switch to the paper log. Export a snapshot if you have not already')
      notify(d, { toRole: 'AA', text: `Network outage declared by ${actor.name}. Reception is on the paper log.`, critical: true })
      return ok('Outage declared. Use the paper log; the snapshot is reference only and does not reserve beds')
    })
  },
  /** AT-026: watermarked, minimum fields, scoped, audited. */
  exportOutageSnapshot(actor: Persona, siteIds?: string[]) {
    return run<string>(d => {
      const e = guard(deny(actor, 'outage.export', 'export the outage snapshot (Outage Export capability)'))
      if (e) return e
      const now = nowMs(), T = dateStr(now)
      const sites = (actor.sites === 'all' ? d.sites.map(s => s.id) : actor.sites).filter(s => !siteIds || siteIds.includes(s))
      const rows: string[][] = []
      for (const r of d.reservations.filter(x => x.status === 'Reserved' && x.from <= dateStr(now + 86400000))) {
        const bed = bedById(d, r.bedId)!; if (!sites.includes(bed.siteId)) continue
        rows.push(['arrival', r.staffId, staffById(d, r.staffId)?.name ?? '', r.from, bed.code, 'Reserved'])
      }
      for (const s of d.stays.filter(x => x.status === 'Active' && (x.end === T || x.end === dateStr(now + 86400000) || x.checkoutRequested))) {
        const bed = bedById(d, s.bedId)!; if (!sites.includes(bed.siteId)) continue
        rows.push(['departure', s.staffId, staffById(d, s.staffId)?.name ?? '', s.end ?? 'requested', bed.code, s.checkoutRequested ? 'Checkout requested' : 'Planned end'])
      }
      const watermark = `CONFIDENTIAL · SNAPSHOT, NOT LIVE AVAILABILITY · generated ${fmtDateTime(now)} · sites ${sites.join('/')} · by ${actor.name}`
      d.exports.unshift({ id: uid(d, 'EX'), at: now, by: actor.name, kind: 'Outage snapshot', rows: rows.length, scope: sites.join(', ') })
      log(d, actor, 'Export: outage snapshot', `${rows.length} rows, sites ${sites.join(', ')}`)
      return ok(`Snapshot exported (${rows.length} rows, audited)`, toCsv(watermark, ['event', 'employee_id', 'name', 'date', 'bed', 'status'], rows))
    })
  },
  logOfflineEvent(actor: Persona, f: { kind: 'arrival' | 'departure'; staffId: string; bedCode: string; at: number }) {
    return run<string>(d => {
      const e = guard(can(actor, 'outage.export') || can(actor, 'outage.reconcile') ? null : deny(actor, 'outage.export', 'enter offline log entries'))
      if (e) return e
      if (!d.outage) return fail('No outage has been declared', 'Reception', 'Declare the outage first')
      const ev: OfflineEvent = { id: uid(d, 'OE'), kind: f.kind, staffId: f.staffId, bedCode: f.bedCode, at: f.at, loggedBy: actor.name, status: 'Pending review' }
      ev.conflict = offlineConflict(d, ev)
      if (ev.conflict) ev.status = 'Conflict'
      d.offlineEvents.push(ev)
      log(d, actor, 'Offline event logged', `${f.kind} ${fullName(d, f.staffId)} · ${f.bedCode}${ev.conflict ? ' · conflict: ' + ev.conflict : ''}`)
      return ok(ev.conflict ? `Logged, with a conflict flagged: ${ev.conflict}` : 'Logged for reconciliation', ev.id)
    })
  },
  restoreService(actor: Persona) {
    return run(d => {
      const e = guard(deny(actor, 'outage.declare', 'declare service restored'))
      if (e) return e
      if (!d.outage || d.outage.restoredAt) return fail('No outage in progress')
      d.outage.restoredAt = nowMs(); d.outage.restoredBy = actor.name
      d.offlineEvents.filter(x => x.status === 'Pending review' || x.status === 'Conflict').forEach(x => { x.conflict = offlineConflict(d, x); x.status = x.conflict ? 'Conflict' : 'Pending review' })
      log(d, actor, 'Service restored', `${d.offlineEvents.length} offline event(s) to reconcile`)
      return ok('Service restored. Reconcile each offline event against live records')
    })
  },
  /** Applies one offline event only if it still validates against live data. Never creates a duplicate stay or a double allocation. */
  reconcileOffline(actor: Persona, id: string, decision: 'apply' | 'dismiss', note: string) {
    return run(d => {
      const e = guard(deny(actor, 'outage.reconcile', 'reconcile offline events'))
      if (e) return e
      const ev = d.offlineEvents.find(x => x.id === id)
      if (!ev || !['Pending review', 'Conflict'].includes(ev.status)) return fail('Already reconciled')
      if (!d.outage?.restoredAt) return fail('Restore service before reconciling', 'Outage owner', 'Mark service restored')
      if (decision === 'dismiss') {
        if (!note.trim()) return fail('Say why it is dismissed', 'You', 'Enter the note')
        ev.status = 'Dismissed'; ev.note = note
      } else {
        const conflict = offlineConflict(d, ev)
        if (conflict) { ev.conflict = conflict; ev.status = 'Conflict'; return fail(`Can't apply: ${conflict}`, 'Accommodation Admin', 'Dismiss it with a note, or fix the live record first') }
        const bed = d.beds.find(b => b.code === ev.bedCode)!
        const T = dateStr(ev.at)
        if (ev.kind === 'arrival') {
          const res = d.reservations.find(r => r.bedId === bed.id && r.staffId === ev.staffId && r.status === 'Reserved')!
          d.stays.push({ id: uid(d, 'S'), bedId: bed.id, staffId: ev.staffId, start: T, end: res.to, status: 'Active', source: 'Standard', stayType: res.stayType })
          res.status = 'CheckedIn'; setBed(d, bed, 'Occupied')
          d.keys.push({ id: uid(d, 'K'), bedId: bed.id, staffId: ev.staffId, kind: 'Room key', status: 'Issued', at: ev.at })
        } else {
          const st = activeStayOfStaff(d, ev.staffId)!
          st.status = 'Ended'; st.checkedOutAt = ev.at
          d.keys.filter(k => k.bedId === bed.id && k.staffId === ev.staffId && k.status === 'Issued').forEach(k => { k.status = 'Returned' })
          setBed(d, bed, 'NeedsCleaning'); openCleaning(d, bed.id)
        }
        ev.status = 'Applied'; ev.note = note || undefined
      }
      ev.reviewedBy = actor.name; ev.reviewedAt = nowMs()
      log(d, actor, `Offline event ${ev.status.toLowerCase()}`, `${ev.kind} ${fullName(d, ev.staffId)} · ${ev.bedCode} · reconciler ${actor.name}`)
      return ok(ev.status === 'Applied' ? 'Applied to live records' : 'Dismissed with a note')
    })
  },

  /** AT-031: scope-filtered, export-controlled and audited. Managers can export only with an explicit grant. */
  exportReport(actor: Persona, kind: ReportKind, siteIds?: string[]) {
    return run<{ csv: string; excluded: number }>(d => {
      const e = guard(deny(actor, 'report.export', 'export reports (needs an explicit grant)'))
      if (e) return e
      const { header, rows, excluded } = reportRows(d, actor, kind, siteIds)
      const now = nowMs()
      const scope = actor.sites === 'all' ? 'all sites' : actor.sites.join(', ')
      const watermark = `CONFIDENTIAL · ${kind} report · as of ${fmtDateTime(now)} · scope ${scope} · exported by ${actor.name}`
      d.exports.unshift({ id: uid(d, 'EX'), at: now, by: actor.name, kind: `Report: ${kind}`, rows: rows.length, scope })
      log(d, actor, `Export: ${kind} report`, `${rows.length} rows, scope ${scope}${excluded ? `, ${excluded} out-of-scope rows excluded` : ''}`)
      return ok(`Exported ${rows.length} rows${excluded ? ` (${excluded} outside your scope excluded)` : ''}. The export is logged`, { csv: toCsv(watermark, header, rows), excluded })
    })
  },
}
