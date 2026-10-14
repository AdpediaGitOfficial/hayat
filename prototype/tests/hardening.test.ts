/* Prototype hardening (PLAN §12 P-1 to P-14): each rule, tested against the same store the screens use.
   Actors are passed through actingAs(), exactly as the app does, so delegations, grants and revoked logins apply. */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { A, getState, resetState } from '../src/domain/store'
import { PERSONAS } from '../src/roles'
import { DAY, HOUR, jump, nowMs, today, addDays } from '../src/domain/time'
import { actingAs, can, suggestBeds } from '../src/domain/rules'
import { approvalInbox } from '../src/domain/select'
import { readStaff, readWorkOrder, listStaff } from '../src/domain/reads'
import { importable, parseStaffCsv, rejectedCsv } from '../src/domain/csv'
import { flaggedStays } from '../src/domain/ext/structures'

const S = () => getState()
const P = (id: string) => PERSONAS.find(p => p.id === id)!
const who = (id: string) => actingAs(S(), P(id), nowMs())      // the actor as the server sees them right now
const bed = (code: string) => S().beds.find(b => b.code === code)!
const staff = (id: string) => S().staff.find(x => x.id === id)!
const reqOf = (id: string) => S().requests.find(r => r.staffId === id && r.status === 'Submitted')!
const ticks = (n = 8) => { for (let i = 0; i < n; i++) A.tick() }
const notes = (pred: (n: ReturnType<typeof S>['notifications'][number]) => boolean) => S().notifications.filter(pred)
const offerFor = (id: string) => S().offers.filter(o => o.staffId === id).at(-1)!
const fail = (r: { ok: boolean }) => assert.equal(r.ok, false)
const okay = (r: { ok: boolean }) => assert.equal(r.ok, true, (r as { reason?: string }).reason ?? '')

beforeEach(() => resetState())

/* ---------- P-1 delegation ---------- */
test('P-1 delegation routes approvals to the delegate for the dates, audited, and expires', () => {
  const q = reqOf('E1030')
  const b = suggestBeds(S(), staff('E1030'), { from: q.arrival, to: q.end }, who('p-aa').sites)[0]
  fail(A.approveRequest(who('p-rec'), q.id, b.id))                       // Reception can't
  assert.equal(approvalInbox(S(), who('p-rec'), nowMs()).filter(i => i.mine && i.kind === 'Request').length, 0)
  okay(A.setDelegation(who('p-aa'), { to: 'Rohan Das', fromDate: today(), toDate: addDays(today(), 7) }))
  assert.ok(S().audit.some(a => a.action === 'Delegation set'))
  assert.deepEqual(who('p-rec').delegatedFrom, ['Anita Rao'])
  assert.ok(approvalInbox(S(), who('p-rec'), nowMs()).some(i => i.mine && i.kind === 'Request'))
  okay(A.approveRequest(who('p-rec'), q.id, b.id))
  jump(8 * DAY)
  assert.equal(who('p-rec').delegatedFrom?.length, 0, 'delegation has expired')
  fail(A.approveRequest(who('p-rec'), reqOf('E1100').id, b.id))
})
test('P-1 separation of duties still applies to a delegate', () => {
  okay(A.submitRequest(who('p-rec'), { staffId: 'E9002', arrival: addDays(today(), 6), end: addDays(today(), 90), stayType: 'Permanent', note: '' }))
  okay(A.setDelegation(who('p-aa'), { to: 'Rohan Das', fromDate: today(), toDate: addDays(today(), 7) }))
  const own = S().requests.find(r => r.staffId === 'E9002')!
  const b = suggestBeds(S(), staff('E9002'), { from: own.arrival, to: own.end }, who('p-rec').sites)[0]
  const r = A.approveRequest(who('p-rec'), own.id, b.id)
  fail(r); assert.match((r as { reason: string }).reason, /own record/)
})

/* ---------- P-2 reminders ---------- */
test('P-2 end-date reminders, overdue notice and escalation notice are generated once', () => {
  const tom = S().stays.find(s => s.staffId === 'E1040')!                 // ends in 40 days
  jump(27 * DAY); ticks()
  assert.equal(notes(n => n.toStaffId === 'E1040' && n.dedupeKey === `end:${tom.id}:14`).length, 1)
  ticks()
  assert.equal(notes(n => n.toStaffId === 'E1040' && /Your stay ends/.test(n.text)).length, 1, 'no duplicate on later ticks')
  jump(12 * DAY); ticks()                                                  // 1 day left → second threshold
  assert.ok(notes(n => n.toStaffId === 'E1040' && n.dedupeKey === `end:${tom.id}:1`).length === 1)
})
test('P-2 overdue stays notify the admin on day 1 and the Policy Approver after the grace period; nobody is checked out', () => {
  ticks()
  assert.ok(notes(n => n.toRole === 'AA' && /past the planned end date/.test(n.text)).length >= 2)
  assert.ok(notes(n => n.toRole === 'PA' && /Overdue beyond/.test(n.text)).length >= 1)
  assert.equal(S().stays.filter(s => s.status === 'Ended').length, 0)
})
test('P-2 an unacknowledged voluntary checkout escalates after 1 business day; acknowledging stops it', () => {
  okay(A.requestCheckout(who('p-res-staying'), S().stays.find(s => s.staffId === 'E1007')!.id))
  okay(A.requestCheckout(who('p-res-out'), S().stays.find(s => s.staffId === 'E1040')!.id))
  okay(A.acknowledgeCheckout(who('p-rec'), S().stays.find(s => s.staffId === 'E1040')!.id))
  jump(2 * DAY); ticks()
  const rahul = S().stays.find(s => s.staffId === 'E1007')!, tom = S().stays.find(s => s.staffId === 'E1040')!
  assert.equal(notes(n => n.dedupeKey === `coack:${rahul.id}`).length, 1)
  assert.equal(notes(n => n.dedupeKey === `coack:${tom.id}`).length, 0)
})

/* ---------- P-3 notification delivery ---------- */
const offerBed = () => suggestBeds(S(), staff('E1033'), { from: today() }, who('p-aa').sites).find(b => b.state === 'Available')!
const makeNehaOffer = () => { const en = S().waitlist.find(w => w.staffId === 'E1033')!; okay(A.makeOffer(who('p-aa'), en.id, offerBed().id)) }
test('P-3 a confirmed email delivery starts the offer clock; "sent" alone does not', () => {
  makeNehaOffer(); ticks(2)
  assert.equal(S().notifications.find(n => n.ref?.kind === 'offer')!.emailStatus, 'sent')
  assert.equal(offerFor('E1033').deliveredAt, undefined, 'accepted by provider is not delivered')
  jump(61_000); ticks(2)
  assert.equal(S().notifications.find(n => n.ref?.kind === 'offer')!.emailStatus, 'delivered')
  assert.equal(offerFor('E1033').deliveredVia, 'email'); assert.ok(offerFor('E1033').expiresAt)
})
test('P-3 provider outage: retries with backoff, then fails visibly; the offer clock never starts and business state is untouched', () => {
  A.setEmailProvider(false); makeNehaOffer()
  const n = () => S().notifications.find(x => x.ref?.kind === 'offer')!
  ticks(2); assert.equal(n().emailStatus, 'retrying'); assert.equal(n().attempts, 1)
  for (const m of [1, 5, 30, 120]) { jump(m * 60_000 + 1000); ticks(2) }
  assert.equal(n().emailStatus, 'failed')
  assert.equal(offerFor('E1033').deliveredAt, undefined); assert.equal(offerFor('E1033').status, 'Pending')
  assert.equal(S().beds.find(b => b.id === offerFor('E1033').bedId)!.heldBy, offerFor('E1033').id)
  jump(25 * HOUR); ticks(2)
  assert.equal(offerFor('E1033').followUp, true, 'Reception is alerted instead of silently expiring')
})
test('P-3 critical alerts that cannot be emailed surface to the admin; manual retry works once the provider is back', () => {
  A.setEmailProvider(false)
  okay(A.raiseSOS(who('p-res-staying'), 'Smoke in corridor'))
  ticks(2); for (const m of [1, 5, 30, 120]) { jump(m * 60_000 + 1000); ticks(2) }
  const sos = S().notifications.find(n => n.critical && n.toRole === 'Sec' && n.text.startsWith('SOS: Smoke'))!
  assert.equal(sos.emailStatus, 'failed')
  assert.ok(notes(n => n.toRole === 'AA' && /could not be emailed/.test(n.text)).length >= 1)
  A.setEmailProvider(true); okay(A.retryNotification(who('p-aa'), sos.id)); ticks(2)
  assert.equal(S().notifications.find(n => n.id === sos.id)!.emailStatus, 'sent')
})
test('P-3 identical notifications are deduplicated; staff without an email address are never emailed', () => {
  makeNehaOffer(); const before = S().notifications.length
  ticks(10); assert.equal(S().notifications.filter(n => n.ref?.kind === 'offer').length, 1)
  assert.ok(S().notifications.length >= before)
  assert.equal(staff('E1030').email !== undefined, true)
  const noEmail = S().staff.find(s => !s.email && s.status === 'Active' && S().stays.some(st => st.staffId === s.id))!
  okay(A.requestCheckout({ ...who('p-res-staying'), staffId: noEmail.id }, S().stays.find(s => s.staffId === noEmail.id)!.id))
  assert.equal(S().notifications.some(n => n.toStaffId === noEmail.id && n.email), false)
})

/* ---------- P-4 visitors ---------- */
const at = (h: number, m = 0) => Date.UTC(2026, 9, 14, h, m) + (nowMs() - Date.UTC(2026, 9, 14, 9, 42) > DAY ? 0 : 0)
test('P-4 visitor flow: register in policy hours → Reception approves → Security gate-in/out; out-of-hours and unapproved are refused', () => {
  fail(A.registerVisitor(who('p-rec'), { name: 'Late Guest', hostStaffId: 'E1007', purpose: 'x', siteId: 'PV', from: at(22), to: at(23, 30) }))
  fail(A.registerVisitor(who('p-res-staying'), { name: 'My Friend', hostStaffId: 'E1007', purpose: 'x', siteId: 'PV', from: at(14), to: at(16) }))    // resident requests off by default
  const r = A.registerVisitor(who('p-rec'), { name: 'Day Guest', hostStaffId: 'E1007', purpose: 'Family', siteId: 'PV', from: at(9, 50), to: at(12) })
  okay(r); const id = (r as { data?: string }).data!
  fail(A.visitorGateIn(who('p-sec'), id, { idChecked: true }))                                  // not approved yet
  fail(A.approveVisitor(who('p-sec'), id))                                                      // security can't approve
  okay(A.approveVisitor(who('p-rec'), id))
  fail(A.visitorGateIn(who('p-sec'), id, { idChecked: false }))
  okay(A.visitorGateIn(who('p-sec'), id, { idChecked: true })); okay(A.visitorGateOut(who('p-sec'), id))
  assert.equal(S().visitors.find(v => v.id === id)!.status, 'Checked out')
})
test('P-4 a visitor who stays past the window is flagged to Security and the host', () => {
  ticks()
  assert.equal(notes(n => n.toRole === 'Sec' && /Visitor overstay: Sana Malik/.test(n.text)).length, 1)
  assert.equal(notes(n => n.toStaffId === 'E1060' && /past the approved time/.test(n.text)).length, 1)
})
test('P-4 a walk-in needs confirmation; a visitor needs a resident host', () => {
  const w = A.registerVisitor(who('p-rec'), { name: 'Walk-in', hostStaffId: 'E1007', purpose: 'x', siteId: 'PV', from: at(9, 40), to: at(10, 30), walkIn: true })
  okay(w); assert.equal(S().visitors.at(-1)!.status, 'Walk-in pending')
  fail(A.registerVisitor(who('p-rec'), { name: 'No host', hostStaffId: 'E1030', purpose: 'x', siteId: 'PV', from: at(10), to: at(11) }))
})

/* ---------- P-5 contractors (AT-023, AT-024) ---------- */
const cv = (id: string) => S().contractorVisits.find(v => v.id === id)!
test('AT-023 a contractor outside the visit window is denied at the gate, the reason is logged and Security sees it', () => {
  okay(A.issueGatePass(who('p-mc'), 'CV3'))                                  // tomorrow's visit
  const r = A.contractorGateIn(who('p-sec'), 'CV3'); fail(r)
  assert.match((r as { reason: string }).reason, /Outside the approved visit window/)
  assert.equal(cv('CV3').status, 'Denied'); assert.ok(cv('CV3').denyReason)
  assert.ok(S().audit.some(a => a.action === 'Contractor access denied'))
})
test('AT-023 expired worker documents stop the gate pass; a suspended contract revokes a visit in progress and alerts Security', () => {
  const r = A.issueGatePass(who('p-mc'), 'CV2'); fail(r); assert.match((r as { reason: string }).reason, /documents expired/)
  fail(A.contractorGateIn(who('p-sec'), 'CV2'))                              // no pass issued
  okay(A.setContractStatus(who('p-mc'), 'CT1', 'Suspended', 'Insurance lapsed'))
  assert.equal(cv('CV1').status, 'Revoked')
  assert.ok(notes(n => n.toRole === 'Sec' && /Access revoked while CoolAir/.test(n.text)).length === 1)
  okay(A.contractorGateOut(who('p-sec'), 'CV1'))
})
test('AT-024 a contractor can neither read nor act on another vendor’s job; their own job works only inside the visit window', () => {
  const mine = S().workOrders.find(w => w.assignee === 'CoolAir Services')!
  const theirs = S().workOrders.find(w => w.assignee === 'BrightSpark Electrical')!
  fail(readWorkOrder(S(), who('p-vend'), theirs.id, nowMs()))
  fail(A.advanceWorkOrder(who('p-vend'), theirs.id, 'Resolved'))
  assert.equal(readWorkOrder(S(), who('p-vend'), mine.id, nowMs()).ok, true)
  okay(A.advanceWorkOrder(who('p-vend'), mine.id, 'Resolved'))
  jump(9 * HOUR)                                                              // 18:42, window closed
  assert.equal(readWorkOrder(S(), who('p-vend'), mine.id, nowMs()).ok, false)
})
test('P-5 a contractor still on site after the window raises an overstay alert', () => {
  jump(8 * HOUR); ticks()                                                     // 17:42
  assert.equal(notes(n => /Contractor overstay/.test(n.text)).length, 1)
})

/* ---------- P-6 SOS (AT-025) ---------- */
test('AT-025 an unacknowledged SOS escalates to the Security Supervisor, then to the accommodation authority, and stays open', () => {
  okay(A.raiseSOS(who('p-res-staying'), 'Fire in kitchen')); const id = S().incidents[0].id
  jump(6 * 60_000); ticks(); assert.equal(S().incidents[0].escalation, 1)
  assert.ok(notes(n => n.toRole === 'Sec' && /NOT ACKNOWLEDGED/.test(n.text)).length === 1)
  jump(11 * 60_000); ticks(); assert.equal(S().incidents[0].escalation, 2)
  assert.ok(notes(n => n.toRole === 'AA' && /STILL UNACKNOWLEDGED/.test(n.text)).length === 1)
  assert.equal(S().incidents[0].closed, undefined)
  fail(A.closeIncident(who('p-sec'), id, 'done'))                              // must acknowledge first
  okay(A.ackIncident(who('p-sec'), id)); fail(A.closeIncident(who('p-sec'), id, '')); okay(A.closeIncident(who('p-sec'), id, 'Extinguished, checked with fire marshal'))
})
test('P-6 an acknowledged SOS does not escalate', () => {
  okay(A.raiseSOS(who('p-res-staying'), 'Medical help')); okay(A.ackIncident(who('p-sec'), S().incidents[0].id))
  jump(30 * 60_000); ticks(); assert.equal(S().incidents[0].escalation ?? 0, 0)
})

/* ---------- P-7 outage (AT-026, AT-027) ---------- */
test('AT-026 outage export is watermarked, minimum-data, scoped, capability-gated and audited', () => {
  fail(A.exportOutageSnapshot(who('p-aa')))                                    // AA has no Outage Export capability
  const r = A.exportOutageSnapshot(who('p-rec')); okay(r)
  const csv = (r as { data: string }).data
  assert.match(csv.split('\n')[0], /SNAPSHOT, NOT LIVE AVAILABILITY/); assert.doesNotMatch(csv, /emergency|\+971|Family/i)
  assert.equal(S().exports[0].kind, 'Outage snapshot'); assert.ok(S().audit.some(a => a.action === 'Export: outage snapshot'))
})
test('AT-027 offline events are validated against live data after restoration; conflicts are flagged and never applied twice', () => {
  fail(A.logOfflineEvent(who('p-rec'), { kind: 'arrival', staffId: 'E1012', bedCode: 'PV-V05-R1-A', at: nowMs() }))   // no outage declared
  okay(A.declareOutage(who('p-rec')))
  okay(A.logOfflineEvent(who('p-rec'), { kind: 'arrival', staffId: 'E1012', bedCode: 'PV-V05-R1-A', at: nowMs() }))   // Ayesha: clean
  okay(A.logOfflineEvent(who('p-rec'), { kind: 'arrival', staffId: 'E1015', bedCode: 'PV-V03-R1-A', at: nowMs() }))   // Joseph: bed not ready
  const [ok1, bad] = S().offlineEvents
  assert.equal(ok1.status, 'Pending review'); assert.equal(bad.status, 'Conflict')
  fail(A.reconcileOffline(who('p-aa'), ok1.id, 'apply', ''))                    // service not restored yet
  okay(A.restoreService(who('p-aa')))
  fail(A.reconcileOffline(who('p-rec'), ok1.id, 'apply', ''))                   // Reception can't reconcile
  fail(A.reconcileOffline(who('p-aa'), bad.id, 'apply', ''))                    // conflict can't be applied
  okay(A.reconcileOffline(who('p-aa'), ok1.id, 'apply', ''))
  assert.equal(S().stays.filter(s => s.staffId === 'E1012' && s.status === 'Active').length, 1)
  fail(A.reconcileOffline(who('p-aa'), ok1.id, 'apply', ''))                    // no duplicate stay
  fail(A.reconcileOffline(who('p-aa'), bad.id, 'dismiss', ''))                  // note required
  okay(A.reconcileOffline(who('p-aa'), bad.id, 'dismiss', 'Bed was not ready; resident re-routed'))
  assert.ok(S().audit.some(a => /Offline event applied/.test(a.action) && /reconciler Anita Rao/.test(a.detail)))
})
test('AT-027 a live change during the outage turns a clean offline event into a conflict', () => {
  okay(A.declareOutage(who('p-rec')))
  okay(A.logOfflineEvent(who('p-rec'), { kind: 'arrival', staffId: 'E1012', bedCode: 'PV-V05-R1-A', at: nowMs() }))
  okay(A.cancelReservation(who('p-aa'), S().reservations.find(r => r.staffId === 'E1012')!.id, 'Moved'))
  okay(A.restoreService(who('p-aa')))
  assert.equal(S().offlineEvents[0].status, 'Conflict')
})

/* ---------- P-8 rehire (AT-032) ---------- */
test('AT-032 rehire reuses the profile; an open clearance case blocks it until the Policy Approver waives; no duplicate is created', () => {
  const count = S().staff.length
  fail(A.rehire(who('p-aa'), 'E1051', { reason: 'Returned', confirm: true }))             // old clearance open
  okay(A.waiveClearance(who('p-pa'), S().clearances[0].id, 'Resident abroad', 'HR mail 77'))
  fail(A.rehire(who('p-aa'), 'E1051', { reason: 'Returned', confirm: false }))            // re-confirmation
  okay(A.rehire(who('p-aa'), 'E1051', { reason: 'Returned', confirm: true }))
  assert.equal(staff('E1051').status, 'Active'); assert.equal(staff('E1051').loginActive, true); assert.equal(S().staff.length, count)
  fail(A.addStaff(who('p-aa'), { id: 'e1051', name: 'Sunil Gupta', gender: 'Male', dept: 'x', grade: 1, phone: '1', emergencyContact: '', joining: today() }))
  fail(A.rehire(who('p-aa'), 'E1007', { reason: 'x', confirm: true }))                    // not left
})

/* ---------- P-9 grants, maker-checker, accounts ---------- */
test('P-9 a capability grant takes effect only after a different Super Admin approves; time-limited grants expire', () => {
  const mgr = () => who('p-mgr')
  fail(A.exportReport(mgr(), 'occupancy'))
  fail(A.requestPermissionChange(who('p-aa'), { kind: 'grant', targetPersonaId: 'p-mgr', cap: 'ReportExport', reason: 'x' }))        // only SA requests
  fail(A.requestPermissionChange(who('p-sa'), { kind: 'grant', targetPersonaId: 'p-mgr', cap: 'ReportExport', reason: '' }))         // reason required
  okay(A.requestPermissionChange(who('p-sa'), { kind: 'grant', targetPersonaId: 'p-mgr', cap: 'ReportExport', reason: 'Quarterly pack', expires: addDays(today(), 3) }))
  const id = S().changes[0].id
  fail(A.exportReport(mgr(), 'occupancy'))                                                         // pending: no effect
  fail(A.decidePermissionChange(who('p-sa'), id, true, ''))                                         // maker can't be checker
  okay(A.decidePermissionChange(who('p-sa2'), id, true, ''))
  okay(A.exportReport(mgr(), 'occupancy'))
  jump(5 * DAY); assert.equal(can(mgr(), 'report.export'), false, 'grant expired')
})
test('P-9 capability grants never widen scope; only a Super Admin changes scope; the last active SA is protected', () => {
  okay(A.requestPermissionChange(who('p-sa'), { kind: 'grant', targetPersonaId: 'p-aa2', cap: 'PolicyApprover', reason: 'cover' }))
  okay(A.decidePermissionChange(who('p-sa2'), S().changes[0].id, true, ''))
  assert.deepEqual(who('p-aa2').sites, ['LV'], 'a grant adds actions, not sites')
  okay(A.requestPermissionChange(who('p-sa'), { kind: 'scope', targetPersonaId: 'p-aa2', sites: ['LV', 'PV'], reason: 'covering Palm Villas' }))
  okay(A.decidePermissionChange(who('p-sa2'), S().changes[1].id, true, ''))
  assert.deepEqual(who('p-aa2').sites, ['LV', 'PV'])
})
test('P-9 with only two Super Admins a change to one of them cannot be decided: the control holds rather than being bypassed', () => {
  okay(A.requestPermissionChange(who('p-sa'), { kind: 'role', targetPersonaId: 'p-sa2', role: 'AA', reason: 'moved teams' }))
  const id = S().changes[0].id
  fail(A.decidePermissionChange(who('p-sa'), id, true, ''))     // requester
  fail(A.decidePermissionChange(who('p-sa2'), id, true, ''))    // the person affected
  assert.equal(S().changes[0].status, 'Pending')
  assert.equal(approvalInbox(S(), who('p-sa'), nowMs()).filter(i => i.kind === 'Permission' && i.mine).length, 0)
})
test('P-9 deactivating an account revokes the login at once; admin accounts are reset by a Super Admin only', () => {
  fail(A.setAccountActive(who('p-aa'), 'p-mc', false, 'left'))                   // AA can't touch an admin account
  okay(A.setAccountActive(who('p-aa'), 'p-res-staying', false, 'Lost phone'))     // AA manages staff accounts
  assert.equal(who('p-res-staying').revoked, true); assert.equal(can(who('p-res-staying'), 'sos.raise'), false)
  okay(A.setAccountActive(who('p-aa'), 'p-res-staying', true, 'Recovered'))
  assert.equal(who('p-res-staying').revoked, false)
  fail(A.setAccountActive(who('p-sa'), 'p-sa', false, 'x'))                      // not your own
  const r = A.resetPassword(who('p-sa'), 'p-mc'); okay(r); assert.match((r as { msg: string }).msg, /offline process/)
  fail(A.resetPassword(who('p-aa'), 'p-mc'))
  assert.equal(S().accounts['p-mc'].mustChange, true)
})
test('Mark as Left revokes the login immediately for the person’s own account (AT-019 detail)', () => {
  assert.equal(who('p-res-reserved').revoked, false)
  okay(A.markLeft(who('p-aa'), 'E1012', { effective: today(), reason: 'Resigned', confirm: true }))
  assert.equal(who('p-res-reserved').revoked, true)
  fail(A.submitRequest(who('p-res-reserved'), { staffId: 'E1012', arrival: today(), end: addDays(today(), 30), stayType: 'Permanent', note: '' }))
})

/* ---------- P-10 structures (AT-029) ---------- */
test('AT-029 rooms and buildings with occupants, reservations, keys or work orders cannot be archived; an empty room can, history retained', () => {
  const room = S().rooms.find(r => r.id === 'PV-V02-R2')!
  const r = A.archiveRoom(who('p-aa'), room.id); fail(r); assert.match((r as { reason: string }).reason, /occupied bed/)
  fail(A.archiveBuilding(who('p-aa'), 'PV-V02'))
  okay(A.addRoom(who('p-aa'), { siteId: 'PV', buildingId: 'PV-V02', name: 'Spare Room', gender: 'Male', beds: 2 }))
  const spare = S().rooms.at(-1)!
  okay(A.archiveRoom(who('p-aa'), spare.id))
  assert.ok(S().rooms.some(x => x.id === spare.id && x.archived)); assert.ok(S().beds.filter(b => b.roomId === spare.id).every(b => b.state === 'Archived'))
  fail(A.archiveRoom(who('p-aa2'), 'PV-V02-R2'))                                    // Lakeview-only admin: out of scope
})
test('D-19 blocking a building stops new allocations to every descendant bed and flags occupants without moving them', () => {
  const q = reqOf('E1030')
  const b = suggestBeds(S(), staff('E1030'), { from: q.arrival, to: q.end }, who('p-aa').sites).find(x => x.code.startsWith('PV-V01'))!
  const stays = JSON.stringify(S().stays)
  okay(A.blockStructure(who('p-aa'), { kind: 'building', id: 'PV-V01', reason: 'Fire damage survey' }))
  const r = A.approveRequest(who('p-aa'), q.id, b.id); fail(r); assert.match((r as { reason: string }).reason, /is blocked/)
  assert.ok(flaggedStays(S()).length > 0); assert.equal(JSON.stringify(S().stays), stays, 'nobody moved')
  assert.ok(suggestBeds(S(), staff('E1030'), { from: q.arrival, to: q.end }, who('p-aa').sites).every(x => !x.code.startsWith('PV-V01')))
  okay(A.unblockStructure(who('p-aa'), { kind: 'building', id: 'PV-V01' }))
  okay(A.approveRequest(who('p-aa'), q.id, b.id))
})

/* ---------- P-11 date-ranged blocks ---------- */
test('P-11 a scheduled block leaves the bed usable until it starts, stops overlapping allocations, then activates and ends by date', () => {
  const b = bed('PV-V01-R3-A'), q = reqOf('E1030')
  okay(A.blockBed(who('p-aa'), b.id, 'Repaint', { from: addDays(today(), 10), to: addDays(today(), 20) }))
  assert.equal(bed('PV-V01-R3-A').state, 'Available')
  fail(A.approveRequest(who('p-aa'), q.id, b.id))                                    // Kiran 16 Oct → 180 days overlaps
  assert.equal(suggestBeds(S(), staff('E1030'), { from: addDays(today(), 2), to: addDays(today(), 8) }, who('p-aa').sites).some(x => x.id === b.id), true)
  jump(11 * DAY); ticks(); assert.equal(bed('PV-V01-R3-A').state, 'Blocked')
  jump(10 * DAY); ticks(); assert.equal(bed('PV-V01-R3-A').state, 'NeedsCleaning')
  assert.ok(S().cleaning.some(t => t.bedId === b.id && t.status === 'Open'))
})

/* ---------- P-12 changes requested ---------- */
test('P-12 an approver can send a request back; it leaves the inbox, keeps its history, and returns when resubmitted', () => {
  const q = reqOf('E1030')
  fail(A.requestChanges(who('p-aa'), q.id, ''))
  okay(A.requestChanges(who('p-aa'), q.id, 'Please confirm the end date'))
  assert.equal(S().requests.find(r => r.id === q.id)!.status, 'ChangesRequested')
  assert.equal(approvalInbox(S(), who('p-aa'), nowMs()).some(i => i.key === q.id), false)
  fail(A.submitRequest(who('p-res-applied'), { staffId: 'E1030', arrival: today(), end: addDays(today(), 30), stayType: 'Permanent', note: '' }))   // still an open request
  okay(A.resubmitRequest(who('p-res-applied'), q.id, { arrival: addDays(today(), 3), end: addDays(today(), 120), note: 'Contract ends in Feb' }))
  const r = S().requests.find(x => x.id === q.id)!
  assert.equal(r.status, 'Submitted'); assert.equal(r.revisions!.length, 1); assert.equal(r.revisions![0].end, q.end)
})
test('P-12 nobody can send their own request back', () => {
  const own = S().requests.find(r => r.staffId === 'E9001')!
  fail(A.requestChanges(who('p-aa'), own.id, 'x'))
})

/* ---------- scoped reads (AT-001, AT-002, AT-031) ---------- */
test('AT-001 a resident cannot read another resident’s profile; they can read their own', () => {
  const other = readStaff(S(), who('p-res-staying'), 'E1012'); fail(other); assert.equal((other as { reason: string }).reason, 'Not found')
  assert.equal(readStaff(S(), who('p-res-staying'), 'E1007').ok, true)
  assert.equal(listStaff(S(), who('p-res-staying')).length, 1)
})
test('AT-002 an admin or officer cannot read staff or jobs at a site outside their scope, and gets "not found"', () => {
  const lakshmi = 'E1045'                                                         // lives at Lakeview
  fail(readStaff(S(), who('p-aa'), lakshmi)); assert.equal(readStaff(S(), who('p-aa2'), lakshmi).ok, true)
  assert.ok(!listStaff(S(), who('p-aa')).some(s => s.id === lakshmi))
  const narrowRec = { ...who('p-rec'), sites: ['LV'] }
  fail(readStaff(S(), narrowRec, 'E1007'))
  fail(readWorkOrder(S(), who('p-aa2'), S().workOrders[0].id, nowMs()))            // Palm Villas job
})
test('AT-001 data minimisation: Reception sees masked phones, Security sees identity only, others see nothing', () => {
  const rec = readStaff(S(), who('p-rec'), 'E1007'); okay(rec)
  assert.match((rec as { data: { phone: string } }).data.phone, /^•••• /)
  assert.equal((rec as { data: { emergencyContact?: string } }).data.emergencyContact, undefined)
  const sec = readStaff(S(), who('p-sec'), 'E1007'); okay(sec)
  assert.deepEqual(Object.keys((sec as { data: object }).data).sort(), ['dept', 'hasPhoto', 'id', 'name', 'phone', 'roomName', 'status'])
  assert.equal((sec as { data: { phone: string } }).data.phone, '')
  fail(readStaff(S(), who('p-mgr'), 'E1007')); fail(readStaff(S(), who('p-aud'), 'E1007')); fail(readStaff(S(), who('p-tech'), 'E1007'))
})
test('AT-031 a manager’s export is scope-filtered, needs an explicit grant, and is logged', () => {
  const mgr = { ...who('p-mgr'), sites: ['LV'], caps: ['ReportExport' as const] }
  const r = A.exportReport(mgr, 'occupancy'); okay(r)
  const { csv, excluded } = (r as { data: { csv: string; excluded: number } }).data
  assert.ok(excluded > 0); assert.doesNotMatch(csv, /PV-V0/); assert.match(csv, /LV-R/)
  assert.ok(S().exports.some(e => e.by === 'Deepa Iyer' && /occupancy/.test(e.kind))); assert.ok(S().audit.some(a => /Export: occupancy report/.test(a.action) && /out-of-scope rows excluded/.test(a.detail)))
  fail(A.exportReport(who('p-mgr'), 'occupancy'))                                  // no grant
})

/* ---------- CSV (AT-004, AT-005) ---------- */
const CSV = `employee_id,full_name,gender,department,designation_or_grade,phone,email_or_username,joining_date,employment_status,emergency_contact_name,emergency_contact_phone
E3001,Hassan Ali,Male,Culinary,2,+971501110001,,2026-10-12,Active,Amina Ali,+971501110099
E1007,Duplicate Rahul,Male,Front office,3,+971501110003,,2026-10-12,Active,,
E3004,=HYPERLINK("http://bad"),Female,Events,2,+971501110004,,2026-10-12,Active,,
E3005,Rina Das,Female,Laundry,2,+971501110005,,13/13/2026,Active,,
E3006,Karthik Raja,Male,Engineering,4,+971501110006,,2026-10-13,Active,Meena Raja,+971501110097
E3006,Karthik Raja,Male,Engineering,4,+971501110006,,2026-10-13,Active,Meena Raja,+971501110097`
test('AT-004 the CSV preview separates accepted, duplicate and invalid rows and commits nothing', () => {
  const before = S().staff.length
  const rows = parseStaffCsv(CSV, S().staff.map(s => s.id))
  assert.deepEqual(rows.map(r => r.status), ['accepted', 'duplicate', 'invalid', 'invalid', 'accepted', 'duplicate'])
  assert.match(rows[2].why, /Formula injection/); assert.match(rows[3].why, /not a valid date/); assert.match(rows[5].why, /earlier in this file/)
  assert.equal(S().staff.length, before)
})
test('AT-005 a partial import saves valid rows exactly once and the rejected rows download with reasons', () => {
  const rows = parseStaffCsv(CSV, S().staff.map(s => s.id)); const before = S().staff.length
  okay(A.commitStaffCsv(who('p-aa'), importable(rows).map(r => r.rec!)))
  assert.equal(S().staff.length, before + 2); assert.ok(staff('E3001')); assert.equal(staff('E3001').verified, false)
  okay(A.commitStaffCsv(who('p-aa'), importable(rows).map(r => r.rec!)))           // repeat: no duplicates
  assert.equal(S().staff.length, before + 2)
  const rej = rejectedCsv(rows); assert.equal(rej.split('\n').length, 5); assert.match(rej, /Formula injection/)
})
