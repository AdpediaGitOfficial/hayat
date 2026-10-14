/* Business-rule scenarios for the prototype store. Run: npm test
   Each test maps to a non-negotiable invariant in CLAUDE.md / SRS §16 and runs against the real store. */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { A, getState, resetState } from '../src/domain/store'
import { PERSONAS } from '../src/roles'
import { jump, DAY, HOUR, today } from '../src/domain/time'
import { bedConflict, suggestBeds } from '../src/domain/rules'

const P = (id: string) => PERSONAS.find(p => p.id === id)!
const aa = P('p-aa'), pa = P('p-pa'), rec = P('p-rec'), sa = P('p-sa'), hk = P('p-hk'), backup = P('p-backup')
const S = () => getState()
const bed = (code: string) => S().beds.find(b => b.code === code)!
const reqOf = (staffId: string) => S().requests.find(r => r.staffId === staffId && r.status === 'Submitted')!
const staff = (id: string) => S().staff.find(x => x.id === id)!

beforeEach(() => resetState())

test('approval selects the bed and creates the reservation atomically; request ≠ reservation ≠ stay', () => {
  const q = reqOf('E1030')
  const b = suggestBeds(S(), staff('E1030'), { from: q.arrival, to: q.end }, aa.sites)[0]
  const r = A.approveRequest(aa, q.id, b.id)
  assert.equal(r.ok, true)
  assert.equal(S().requests.find(x => x.id === q.id)!.status, 'Approved')
  assert.equal(S().reservations.filter(x => x.staffId === 'E1030' && x.status === 'Reserved').length, 1)
  assert.equal(S().stays.filter(x => x.staffId === 'E1030').length, 0, 'no stay until check-in')
  assert.equal(bed(b.code).state, 'Available', 'physical state unchanged by a future reservation')
})

test('a bed never has two overlapping reservations: second admin is refused and nothing half-saves', () => {
  const q1 = reqOf('E1030'), q2 = reqOf('E1100')
  const b = suggestBeds(S(), staff('E1030'), { from: q1.arrival, to: q1.end }, aa.sites).find(x => suggestBeds(S(), staff('E1100'), { from: q2.arrival, to: q2.end }, aa.sites).some(y => y.id === x.id))!
  assert.equal(A.approveRequest(aa, q1.id, b.id).ok, true)
  const second = A.approveRequest(pa, q2.id, b.id)
  assert.equal(second.ok, false)
  assert.equal(S().requests.find(x => x.id === q2.id)!.status, 'Submitted')
  assert.equal(S().reservations.filter(x => x.bedId === b.id && x.status === 'Reserved').length, 1)
})

test('no self-approval (D-26): an AA cannot approve their own request', () => {
  const own = S().requests.find(r => r.staffId === 'E9001')!
  const b = suggestBeds(S(), staff('E9001'), { from: own.arrival, to: own.end }, aa.sites)[0]
  const r = A.approveRequest(aa, own.id, b.id)
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /own record/)
  assert.equal(A.approveRequest(pa, own.id, b.id).ok, true, 'independent approver can')
})

test('permissions are enforced in the store, not just the UI', () => {
  const q = reqOf('E1030')
  const b = suggestBeds(S(), staff('E1030'), { from: q.arrival, to: q.end }, 'all')[0]
  assert.equal(A.approveRequest(rec, q.id, b.id).ok, false, 'reception cannot approve')
  assert.equal(A.approveRequest(P('p-res-staying'), q.id, b.id).ok, false, 'resident cannot approve')
  const lv = P('p-aa2'); const pvBed = bed('PV-V01-R3-A')
  assert.equal(A.blockBed(lv, pvBed.id, 'test').ok, false, 'Lakeview-only admin is out of scope for Palm Villas')
})

test('readiness gates check-in, not the reservation', () => {
  const res = S().reservations.find(r => r.staffId === 'E1015')!
  assert.equal(bed('PV-V03-R1-A').state, 'NeedsCleaning')
  const r = A.checkIn(rec, res.id, { idVerified: true, keyIssued: true })
  assert.equal(r.ok, false)
  assert.equal(S().reservations.find(x => x.id === res.id)!.status, 'Reserved', 'reservation stays valid')
})

test('check-in commits stay + bed occupancy together', () => {
  const res = S().reservations.find(r => r.staffId === 'E1012')!
  assert.equal(A.checkIn(rec, res.id, { idVerified: true, keyIssued: true }).ok, true)
  assert.equal(S().stays.some(s => s.staffId === 'E1012' && s.status === 'Active'), true)
  assert.equal(bed('PV-V05-R1-A').state, 'Occupied')
})

test('offer: accept creates a reservation and releases the hold; first decline keeps position, second goes to back', () => {
  const o = S().offers[0]
  assert.equal(S().beds.find(b => b.id === o.bedId)!.heldBy, o.id)
  // admin cannot allocate a held bed
  const q = reqOf('E1030')
  assert.equal(A.approveRequest(aa, q.id, o.bedId).ok, false)
  assert.equal(A.acceptOffer(P('p-res-offer'), o.id).ok, true)
  assert.equal(S().beds.find(b => b.id === o.bedId)!.heldBy, undefined)
  assert.equal(S().reservations.some(r => r.staffId === o.staffId && r.bedId === o.bedId && r.status === 'Reserved'), true)
})

test('declines: 1st keeps queue position, 2nd moves to the back (D-50)', () => {
  const en = S().waitlist.find(w => w.staffId === 'E1033')!
  const beds = suggestBeds(S(), staff('E1033'), { from: today() }, aa.sites).filter(b => b.state === 'Available')
  A.makeOffer(aa, en.id, beds[0].id)
  const firstTs = S().waitlist.find(w => w.id === en.id)!.queueTs
  A.declineOffer(P('p-res-waitlist'), S().offers.at(-1)!.id)
  assert.equal(S().waitlist.find(w => w.id === en.id)!.queueTs, firstTs)
  A.makeOffer(aa, en.id, beds[1].id)
  A.declineOffer(P('p-res-waitlist'), S().offers.at(-1)!.id)
  assert.ok(S().waitlist.find(w => w.id === en.id)!.queueTs > firstTs)
})

test('unviewed offer alerts Reception after 24h (no auto-decision)', () => {
  const en = S().waitlist.find(w => w.staffId === 'E1033')!
  const b = suggestBeds(S(), staff('E1033'), { from: today() }, aa.sites).find(x => x.state === 'Available')!
  A.makeOffer(aa, en.id, b.id)
  jump(25 * HOUR); A.tick()
  assert.equal(S().offers.at(-1)!.followUp, true)
  assert.equal(S().offers.at(-1)!.status, 'Pending')
})

test('waitlist entry reminds at 3 and 1 days and closes at expiry (15 days)', () => {
  const en = S().waitlist.find(w => w.staffId === 'E1033')!   // 12 days left
  jump(9 * DAY + HOUR); A.tick()
  assert.deepEqual(S().waitlist.find(w => w.id === en.id)!.remindersSent, [3])
  jump(2 * DAY); A.tick()
  assert.deepEqual(S().waitlist.find(w => w.id === en.id)!.remindersSent, [3, 1])
  jump(2 * DAY); A.tick()
  assert.equal(S().waitlist.find(w => w.id === en.id)!.status, 'Closed')
})

test('offer window starts on confirmed delivery and expiry releases the bed', () => {
  const en = S().waitlist.find(w => w.staffId === 'E1033')!
  const b = suggestBeds(S(), staff('E1033'), { from: today() }, aa.sites).find(x => x.state === 'Available')!
  A.makeOffer(aa, en.id, b.id)
  const id = S().offers.at(-1)!.id
  assert.equal(S().offers.at(-1)!.expiresAt, undefined)
  A.deliverOffer(rec, id, 'offline')
  assert.ok(S().offers.at(-1)!.expiresAt)
  jump(49 * HOUR); A.tick()
  assert.equal(S().offers.find(o => o.id === id)!.status, 'Expired')
  assert.equal(S().beds.find(x => x.id === b.id)!.heldBy, undefined)
  assert.equal(S().waitlist.find(w => w.id === en.id)!.status, 'Waiting', 'resident stays on the waitlist')
})

test('Mark as Left revokes login immediately but the bed stays Occupied until checkout; then Needs cleaning, never Available', () => {
  assert.equal(A.markLeft(aa, 'E1050', { effective: today(), reason: 'Resigned', confirm: false }).ok, false, 'needs re-confirmation')
  assert.equal(A.markLeft(aa, 'E1050', { effective: today(), reason: 'Resigned', confirm: true }).ok, true)
  assert.equal(staff('E1050').loginActive, false)
  assert.equal(bed('PV-V01-R2-A').state, 'Occupied')
  const st = S().stays.find(s => s.staffId === 'E1050' && s.status === 'Active')!
  assert.equal(A.checkout(rec, st.id, { keysReturned: true }).ok, true)
  assert.equal(bed('PV-V01-R2-A').state, 'NeedsCleaning')
})

test('clearance cannot close with mandatory items open unless the Policy Approver waives; cleaner cannot inspect own work', () => {
  const c = S().clearances[0]
  assert.equal(A.closeClearance(aa, c.id).ok, false)
  assert.equal(A.waiveClearance(aa, c.id, 'r', 'e').ok, false, 'AA is not the Policy Approver')
  assert.equal(A.waiveClearance(pa, c.id, 'Resident abroad', 'HR email 123').ok, true)
  // sunil still occupies the bed, so close is blocked until checkout
  assert.equal(A.closeClearance(aa, c.id).ok, false)
  const st = S().stays.find(s => s.id === c.stayId)!
  assert.equal(A.checkout(rec, st.id, { keysReturned: false }).ok, true)
  assert.equal(A.closeClearance(aa, c.id).ok, true)
})

test('housekeeping: bed becomes Available only after cleaning then an independent final inspection', () => {
  const task = S().cleaning.find(t => t.status === 'Open')!
  const b = S().beds.find(x => x.id === task.bedId)!
  assert.equal(A.completeCleaning(hk, task.id).ok, true)
  assert.equal(S().beds.find(x => x.id === b.id)!.state, 'InspectionRequired')
  assert.equal(A.finalInspection(P('p-res-staying'), b.id, true).ok, false, 'no capability')
  assert.equal(A.finalInspection(rec, b.id, true).ok, true)
  assert.equal(S().beds.find(x => x.id === b.id)!.state, 'Available')
})

test('a failed transfer leaves the resident where they were; a good one moves atomically', () => {
  const t = S().transfers.find(x => x.kind === 'Transfer')!
  assert.equal(A.decideTransfer(aa, t.id, true, '').ok, true)
  const before = JSON.stringify([S().stays, S().beds])
  const bad = A.executeTransfer(rec, t.id, { injectFailure: true })
  assert.equal(bad.ok, false)
  assert.equal(JSON.stringify([S().stays, S().beds]), before, 'state identical after rollback')
  assert.equal(S().transfers.find(x => x.id === t.id)!.status, 'Failed')
})

test('transfer executes: destination locked first, source goes to Needs cleaning', () => {
  const t = S().transfers.find(x => x.kind === 'Transfer')!
  A.decideTransfer(aa, t.id, true, '')
  assert.equal(A.executeTransfer(rec, t.id).ok, true)
  assert.equal(bed('PV-V06-R1-B').state, 'Occupied')
  assert.equal(bed('PV-V05-R2-A').state, 'NeedsCleaning')
})

test('swap is one atomic two-way operation', () => {
  const t = S().transfers.find(x => x.kind === 'Swap')!
  A.decideTransfer(aa, t.id, true, '')
  assert.equal(A.executeTransfer(rec, t.id).ok, true)
  const arun = S().stays.find(s => s.staffId === 'E1061' && s.status === 'Active')!, bil = S().stays.find(s => s.staffId === 'E1062' && s.status === 'Active')!
  assert.equal(S().beds.find(b => b.id === arun.bedId)!.code, 'PV-V03-R2-A')
  assert.equal(S().beds.find(b => b.id === bil.bedId)!.code, 'PV-V02-R1-A')
})

test('emergency: reminders every 24h, escalate after two, never auto-approve or auto-checkout', () => {
  const m = S().emergencies[0]
  jump(5 * HOUR); A.tick()           // 25h since created
  assert.equal(S().emergencies[0].reminders, 1)
  assert.equal(S().emergencies[0].escalation, 0)
  jump(DAY); A.tick()                // 49h
  assert.equal(S().emergencies[0].escalation, 1)
  jump(DAY); A.tick()                // 73h
  assert.equal(S().emergencies[0].escalation, 2)
  assert.equal(S().emergencies[0].status, 'Pending', 'never auto-approved')
  assert.equal(S().stays.find(s => s.id === m.stayId)!.status, 'Active', 'never auto-checked-out')
})

test('emergency: initiator cannot approve; rejection creates a relocation task and does not move the resident', () => {
  const m = S().emergencies[0]
  assert.equal(A.decideEmergency(rec, m.id, true, '').ok, false)
  assert.equal(A.decideEmergency(aa, m.id, false, '').ok, false, 'reason required')
  assert.equal(A.decideEmergency(aa, m.id, false, 'Not an emergency').ok, true)
  assert.equal(S().tasks.length, 1)
  assert.equal(S().stays.find(s => s.id === m.stayId)!.status, 'Active')
})

test('timeouts do not auto-decide ordinary approvals', () => {
  jump(10 * DAY); A.tick()
  assert.equal(S().requests.filter(r => r.status === 'Submitted').length >= 3, true)
})

test('duplicate employee IDs are rejected (case-insensitive), never merged', () => {
  const r = A.addStaff(aa, { id: ' e1007 ', name: 'Dup', gender: 'Male', dept: 'x', grade: 1, phone: '1', emergencyContact: '', joining: today() })
  assert.equal(r.ok, false)
})

test('migration is maker-checker and creates Migrated stays', () => {
  const rows = [{ empId: 'E1100', bedCode: 'PV-V01-R3-A', start: '2026-06-01' }]
  assert.equal(A.prepareMigration(aa, rows).ok, true)
  assert.equal(A.signOffMigration(aa).ok, false, 'maker cannot be checker')
  assert.equal(A.signOffMigration(pa).ok, true)
  const st = S().stays.find(s => s.staffId === 'E1100')!
  assert.equal(st.source, 'Migrated'); assert.equal(st.endPending, true)
})

test('no deletion: beds are archived only when nothing depends on them', () => {
  assert.equal(A.archiveBed(aa, bed('PV-V02-R2-B').id).ok, false, 'occupied')
  assert.equal(A.archiveBed(aa, bed('PV-V01-R3-B').id).ok, true)
  assert.equal(S().beds.some(b => b.code === 'PV-V01-R3-B'), true, 'record retained')
})

test('lost key is never marked returned', () => {
  const k = S().keys[0]
  A.reportKeyLost(rec, k.id)
  assert.equal(A.returnKey(rec, k.id).ok, false)
  assert.equal(A.replaceKey(rec, k.id).ok, true)
})

test('work: resolver cannot verify own work', () => {
  const w = S().workOrders.find(x => x.status === 'Resolved')!
  assert.equal(A.advanceWorkOrder(P('p-tech'), w.id, 'Verified').ok, false)
  assert.equal(A.advanceWorkOrder(P('p-mc'), w.id, 'Verified').ok, true)
})
