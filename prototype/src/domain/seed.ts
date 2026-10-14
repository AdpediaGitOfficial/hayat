import type { Bed, Building, Config, Gender, Room, RoomGender, Site, State, Staff, Stay, StayType, Reservation } from './types'
import { BASE, DAY, HOUR, addDays, today } from './time'

export const DEFAULT_CONFIG: Config = {
  waitlistDays: 15, waitlistReminderDays: [3, 1], offerHours: 48, offerFollowUpHours: 24,
  emergencyDeadlineHours: 24, emergencyEscalateAfter: 2, slaBusinessDays: 2, noShowHours: 24,
  sosAckMinutes: 5, emergencyRelocationHours: 48, overdueGraceDays: 3, extensionPolicyDays: 90, endReminderDays: [14, 7, 1],
  genderStrict: true,
  // GH-03 is OPEN: placeholder eligibility rules, configurable under Configuration. Never hardcoded in logic.
  minGradeBySite: { MA: 4 },
  priorityCategories: ['Standard', 'Priority (placeholder, GH-04)'],
  sosEscalationMinutes: 10, notificationDedupeMinutes: 60, emailBackoffMinutes: [1, 5, 30, 120], emailDeliveredAfterSeconds: 60,
  visitorHours: { open: '08:00', close: '22:00' }, visitorOvernight: false, residentVisitorRequests: false,
}

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MALE = ['Aarav', 'Vivek', 'Sandeep', 'Rajesh', 'Farid', 'Nikhil', 'Joseph', 'Manoj', 'Yusuf', 'Harish', 'Ganesh', 'Pradeep', 'Samir', 'Thomas', 'Vijay', 'Anwar', 'Dinesh', 'Suraj', 'Mohan', 'Ibrahim', 'Rohit', 'Lokesh', 'Faisal', 'George', 'Naveed', 'Prakash', 'Ajay', 'Cyril', 'Hamza', 'Kunal']
const FEMALE = ['Divya', 'Sana', 'Mariam', 'Pooja', 'Anjali', 'Rekha', 'Sheela', 'Fatima', 'Jyoti', 'Maya', 'Nandini', 'Leena', 'Shirin', 'Teresa', 'Uma', 'Zainab', 'Bindu', 'Chitra', 'Deepti', 'Esha', 'Gita', 'Hema', 'Indu', 'Kavya', 'Lata', 'Meghna', 'Noor', 'Preeti', 'Rina', 'Sunita']
const LAST = ['Thomas', 'Kurian', 'Shetty', 'Nambiar', 'Hussain', 'Reddy', 'D\'Souza', 'Pillai', 'Gupta', 'Mehta', 'Verma', 'Abraham', 'Khan', 'Rao', 'Iyer', 'Bose', 'Chandran', 'Fernandes', 'Joshi', 'Menon', 'Sinha', 'Varghese', 'Ansari', 'Malik']
const DEPTS = ['Front office', 'Culinary', 'Housekeeping', 'Engineering', 'Spa', 'F&B service', 'Security', 'Finance', 'Events', 'Laundry']

export function buildSeed(): State {
  const now = BASE
  const T = today(now)
  let n = 0
  const id = (p: string) => `${p}${++n}`
  const sites: Site[] = [
    { id: 'PV', code: 'PV', name: 'Palm Villas', kind: 'Villa', minGrade: 1 },
    { id: 'MA', code: 'MA', name: 'Marina Apartments', kind: 'Apartment', minGrade: 4 },
    { id: 'LV', code: 'LV', name: 'Lakeview Annex', kind: 'Villa', minGrade: 1 },
  ]
  const buildings: Building[] = []
  const rooms: Room[] = []
  const beds: Bed[] = []
  const letters = ['A', 'B', 'C', 'D']
  const mkBeds = (room: Room, siteCode: string, prefix: string, count: number) => {
    for (let i = 0; i < count; i++) beds.push({ id: `${room.id}-${letters[i]}`, code: `${prefix}-${letters[i]}`, roomId: room.id, siteId: siteCode, state: 'Available' })
  }
  // Palm Villas: Site → Building (villa) → Room → Bed (no floor/unit)
  for (let v = 1; v <= 20; v++) {
    const vv = String(v).padStart(2, '0')
    const b: Building = { id: `PV-V${vv}`, siteId: 'PV', name: `Villa ${vv}` }
    buildings.push(b)
    const g: RoomGender = v <= 4 || (v >= 9 && v <= 14) ? 'Male' : v === 8 ? 'Any' : 'Female'
    ;[4, 3, 3].forEach((cnt, i) => {
      const r: Room = { id: `PV-V${vv}-R${i + 1}`, siteId: 'PV', buildingId: b.id, name: `Room ${i + 1}`, gender: g }
      rooms.push(r); mkBeds(r, 'PV', `PV-V${vv}-R${i + 1}`, cnt)
    })
  }
  // Marina: Site → Building (block) → Floor → Room → Bed
  for (const blk of ['A', 'B', 'C', 'D']) {
    const b: Building = { id: `MA-${blk}`, siteId: 'MA', name: `Block ${blk}` }
    buildings.push(b)
    for (const fl of [1, 2]) for (let r = 1; r <= 3; r++) {
      const num = `${fl}0${r}`
      const room: Room = { id: `MA-${blk}-${num}`, siteId: 'MA', buildingId: b.id, floor: `Floor ${fl}`, name: `Room ${num}`, gender: blk === 'A' || blk === 'C' ? 'Female' : 'Male' }
      rooms.push(room); mkBeds(room, 'MA', `MA-${blk}-F${fl}-${num}`, 2)
    }
  }
  // Lakeview: Site → Room → Bed (no building: a villa is a site)
  for (let r = 1; r <= 4; r++) {
    const room: Room = { id: `LV-R${r}`, siteId: 'LV', name: `Room ${r}`, gender: r <= 2 ? 'Female' : 'Male' }
    rooms.push(room); mkBeds(room, 'LV', `LV-R${r}`, 2)
  }
  const bedByCode = (c: string) => { const b = beds.find(x => x.code === c); if (!b) throw new Error('seed bed ' + c); return b }
  const roomOf = (b: Bed) => rooms.find(r => r.id === b.roomId)!

  const staff: Staff[] = []
  const mk = (sid: string, name: string, gender: Gender, dept: string, grade: number, extra: Partial<Staff> = {}) => {
    const s: Staff = {
      id: sid, name, gender, dept, grade, phone: `+971 50 ${String(1000000 + (staff.length * 7919) % 8999999).slice(0, 7)}`,
      email: undefined, status: 'Active', emergencyContact: 'Family · +91 98xxxxxx', joining: addDays(T, -200 - staff.length), verified: true, loginActive: true, exceptions: [], source: 'Seed', ...extra,
    }
    staff.push(s); return s
  }
  // admins & operators (also staff records)
  mk('E9001', 'Anita Rao', 'Female', 'Accommodation', 5); mk('E9002', 'Rohan Das', 'Male', 'Reception', 3)
  mk('E9003', 'Suresh Menon', 'Male', 'Accommodation', 7); mk('E9004', 'Naveen Kapoor', 'Male', 'Accommodation', 6)
  mk('E9005', 'Vikram Shah', 'Male', 'IT', 6); mk('E9006', 'Meera Pillai', 'Female', 'Engineering', 5)
  mk('E9007', 'Arjun Nair', 'Male', 'Engineering', 3); mk('E9008', 'Sanjay Kumar', 'Male', 'Security', 3)
  mk('E9009', 'Deepa Iyer', 'Female', 'Operations', 6); mk('E9010', 'Farhan Ali', 'Male', 'Internal audit', 6); mk('E9011', 'Kavita Nair', 'Female', 'Accommodation', 5); mk('E9012', 'Meghna Rao', 'Female', 'IT', 6)
  // scenario residents
  const rahul = mk('E1007', 'Rahul Menon', 'Male', 'Front office', 3)
  const ayesha = mk('E1012', 'Ayesha Khan', 'Female', 'Culinary', 3)
  const joseph = mk('E1015', 'Joseph Mathew', 'Male', 'Engineering', 3)
  const priya = mk('E1021', 'Priya Nair', 'Female', 'Spa', 2)
  const kiran = mk('E1030', 'Kiran Patel', 'Male', 'Finance', 3)
  const neha = mk('E1033', 'Neha Sharma', 'Female', 'Events', 2)
  const omar = mk('E1036', 'Omar Farouk', 'Male', 'F&B service', 2)
  const tom = mk('E1040', 'Tom Fernandes', 'Male', 'Culinary', 2)
  const lakshmi = mk('E1045', 'Lakshmi Devi', 'Female', 'Housekeeping', 1)
  const dev = mk('E1050', 'Dev Malhotra', 'Male', 'Engineering', 3)
  const sunil = mk('E1051', 'Sunil Gupta', 'Male', 'Laundry', 2, { status: 'Left', loginActive: false, leftAt: now - 6 * DAY, leftEffective: addDays(T, -6) })
  const meena = mk('E1060', 'Meena Joseph', 'Female', 'Spa', 2)
  const arun = mk('E1061', 'Arun Kurian', 'Male', 'F&B service', 2)
  const bilal = mk('E1062', 'Bilal Hussain', 'Male', 'Culinary', 2)
  const imran = mk('E1070', 'Imran Sheikh', 'Male', 'Security', 2)
  const farah = mk('E1080', 'Farah Siddiqui', 'Female', 'Front office', 3)
  const mgrRes = mk('E1090', 'Zoya Bhatt', 'Female', 'Finance', 5)
  ;[rahul, ayesha, priya, tom, lakshmi, meena, imran].forEach(x => { x.hasPhoto = true })
  ;[rahul, ayesha, joseph, priya, kiran, neha, omar, tom, dev, meena, farah].forEach(x => { x.email = `${x.name.split(' ')[0].toLowerCase()}@example.com` })   // others have no email: reached in-app and by Reception   // photos are optional (G-05); Joseph has none

  const stays: Stay[] = []
  const reservations: Reservation[] = []
  const occupy = (s: Staff, code: string, startOffset: number, endOffset: number | null, type: StayType = 'Permanent', extra: Partial<Stay> = {}) => {
    const b = bedByCode(code); b.state = 'Occupied'
    const st: Stay = { id: id('S'), bedId: b.id, staffId: s.id, start: addDays(T, startOffset), end: endOffset === null ? undefined : addDays(T, endOffset), status: 'Active', source: 'Standard', stayType: type, ...extra }
    stays.push(st); return st
  }
  const reserve = (s: Staff, code: string, fromOffset: number, toOffset: number | null, etaMs: number, type: StayType = 'Permanent', extra: Partial<Reservation> = {}) => {
    const b = bedByCode(code)
    const r: Reservation = { id: id('R'), bedId: b.id, staffId: s.id, from: addDays(T, fromOffset), to: toOffset === null ? undefined : addDays(T, toOffset), eta: etaMs, status: 'Reserved', createdAt: now - 3 * DAY, source: 'Request', stayType: type, ...extra }
    reservations.push(r); return r
  }
  occupy(rahul, 'PV-V02-R2-B', -226, 140)
  occupy(tom, 'PV-V01-R1-C', -110, 40, 'Contract', { checkoutRequested: true })
  occupy(lakshmi, 'LV-R1-A', -300, 65)
  occupy(dev, 'PV-V01-R2-A', -150, 215)
  const sunilStay = occupy(sunil, 'PV-V04-R1-A', -400, 30)
  sunilStay.exitPending = true
  occupy(meena, 'PV-V05-R2-A', -80, 285)
  const arunStay = occupy(arun, 'PV-V02-R1-A', -60, 120)
  const bilalStay = occupy(bilal, 'PV-V03-R2-A', -45, 130)
  occupy(mgrRes, 'MA-A-F1-101-A', -500, 200)
  const imranStay = occupy(imran, 'PV-V08-R1-A', 0, 3, 'Contract', { source: 'Provisional', emergencyId: 'EM1' })
  // reservations
  const etaToday = (h: number, m = 0) => Date.UTC(2026, 9, 14, h, m)
  reserve(ayesha, 'PV-V05-R1-A', 0, 365, etaToday(13)); reserve(joseph, 'PV-V03-R1-A', 0, 300, etaToday(15, 45), 'Contract')
  reserve(priya, 'PV-V06-R3-C', 0, 120, etaToday(9), 'Trainee')
  bedByCode('PV-V03-R1-A').state = 'NeedsCleaning'; bedByCode('PV-V03-R1-A').since = now - 2 * HOUR
  // offer-held bed
  const omarBed = bedByCode('PV-V04-R3-C')
  // blocked / maintenance / readiness
  const blk = bedByCode('PV-V03-R3-A'); blk.state = 'Blocked'; blk.reason = 'Ceiling leak: waiting on contractor'; blk.since = now - 9 * DAY
  const blk2 = bedByCode('PV-V03-R3-B'); blk2.state = 'Blocked'; blk2.reason = 'Ceiling leak: waiting on contractor'; blk2.since = now - 9 * DAY
  const um = bedByCode('PV-V07-R2-C'); um.state = 'UnderMaintenance'; um.reason = 'AC replacement'; um.since = now - 2 * DAY
  const insp = bedByCode('PV-V06-R2-A'); insp.state = 'InspectionRequired'; insp.since = now - 3 * HOUR
  const nc = bedByCode('PV-V04-R2-B'); nc.state = 'NeedsCleaning'; nc.since = now - 5 * HOUR

  // random fill of remaining beds
  const R = rng(14102026)
  const used = new Set(staff.map(s => s.name))
  const pool = (g: Gender, minGrade: number) => {
    for (;;) {
      const first = (g === 'Male' ? MALE : FEMALE)[Math.floor(R() * 30)], last = LAST[Math.floor(R() * LAST.length)]
      const name = `${first} ${last}`
      if (used.has(name)) continue
      used.add(name)
      const s = mk(`E${2000 + staff.length}`, name, g, DEPTS[Math.floor(R() * DEPTS.length)], Math.max(minGrade, 1 + Math.floor(R() * 5)))
      return s
    }
  }
  const nextBeds = beds.filter(b => b.state === 'Available' && !['PV-V05-R1-A', 'PV-V06-R3-C', 'PV-V04-R3-C', 'PV-V06-R1-B', 'PV-V08-R1-B'].includes(b.code))
  // Keep a few Available beds for demos (offers, transfers, allocation conflicts, bulk allocation); every other bed is occupied,
  // which puts the Palm Villas + Marina occupancy headline at about 92%.
  const keepFree = new Set(['PV-V01-R3-A', 'PV-V02-R3-A', 'PV-V05-R3-A', 'PV-V06-R1-A', 'PV-V07-R1-A', 'PV-V08-R2-A', 'MA-B-F1-101-A', 'MA-A-F2-201-A', 'LV-R3-A', 'LV-R3-B'])
  for (const b of nextBeds) {
    if (keepFree.has(b.code)) continue
    const room = roomOf(b)
    const site = sites.find(s => s.id === b.siteId)!
    const g: Gender = room.gender === 'Any' ? (R() > 0.5 ? 'Male' : 'Female') : room.gender
    const st = pool(g, site.minGrade)
    occupy(st, b.code, -Math.floor(30 + R() * 300), Math.floor(R() * 25) === 0 ? 3 + Math.floor(R() * 5) : 40 + Math.floor(R() * 300), (['Permanent', 'Contract', 'Trainee'] as StayType[])[Math.floor(R() * 3)])
  }
  // a few overstays (past planned end)
  stays.filter(s => s.source === 'Standard' && s.status === 'Active' && s.end && s.end >= addDays(T, 3) && s.staffId.startsWith('E2')).slice(0, 2).forEach((s, i) => { s.end = addDays(T, -(2 + i * 3)) })

  // requests
  const requests = [
    { id: id('Q'), staffId: kiran.id, createdAt: now - 20 * HOUR, arrival: addDays(T, 2), end: addDays(T, 180), stayType: 'Permanent' as StayType, note: 'Joining Finance on 16 Oct', status: 'Submitted' as const, submittedBy: kiran.id },
    { id: id('Q'), staffId: mk('E1100', 'Naveen Reddy', 'Male', 'Engineering', 3).id, createdAt: now - 3 * DAY, arrival: addDays(T, 9), end: addDays(T, 200), stayType: 'Contract' as StayType, note: 'Relocating from Doha property', status: 'Submitted' as const, submittedBy: 'E9002', onBehalf: true },
    { id: id('Q'), staffId: mk('E1101', 'Sara Mathew', 'Female', 'Spa', 2).id, createdAt: now - 2 * DAY, arrival: addDays(T, 7), end: addDays(T, 90), stayType: 'Trainee' as StayType, note: 'Spa trainee batch', status: 'Submitted' as const, submittedBy: 'E1101' },
    { id: id('Q'), staffId: 'E9001', createdAt: now - 1 * DAY, arrival: addDays(T, 12), end: addDays(T, 300), stayType: 'Permanent' as StayType, note: 'Moving closer to the property', status: 'Submitted' as const, submittedBy: 'E9001' },
    { id: id('Q'), staffId: farah.id, createdAt: now - 6 * DAY, arrival: addDays(T, -2), end: addDays(T, 60), stayType: 'Contract' as StayType, note: 'Cancelled by requester', status: 'Cancelled' as const, submittedBy: farah.id },
  ]
  // waitlist & offer
  const entryNeha = { id: id('W'), staffId: neha.id, createdAt: now - 3 * DAY, queueTs: now - 3 * DAY, expiresAt: now + 12 * DAY, priority: 'Standard', declines: 0, skipBeds: [] as string[], status: 'Waiting' as const, remindersSent: [] as number[], gender: neha.gender }
  const entry2 = { id: id('W'), staffId: mk('E1102', 'Lina Joseph', 'Female', 'Culinary', 2).id, createdAt: now - 6 * DAY, queueTs: now - 6 * DAY, expiresAt: now + 3 * DAY + 2 * HOUR, priority: 'Standard', declines: 1, skipBeds: [] as string[], status: 'Waiting' as const, remindersSent: [] as number[], gender: 'Female' as Gender }
  const entry3 = { id: id('W'), staffId: mk('E1103', 'Rizwan Ahmed', 'Male', 'Security', 2).id, createdAt: now - 9 * DAY, queueTs: now - 9 * DAY, expiresAt: now + 6 * DAY, priority: 'Standard', declines: 0, skipBeds: [] as string[], status: 'Waiting' as const, remindersSent: [] as number[], gender: 'Male' as Gender }
  const entryOmar = { id: id('W'), staffId: omar.id, createdAt: now - 11 * DAY, queueTs: now - 11 * DAY, expiresAt: now + 4 * DAY, priority: 'Standard', declines: 0, skipBeds: [] as string[], status: 'Offered' as const, remindersSent: [] as number[], gender: omar.gender }
  const offer = { id: id('O'), entryId: entryOmar.id, staffId: omar.id, bedId: omarBed.id, createdAt: now - 30 * HOUR, deliveredAt: now - 28 * HOUR, deliveredVia: 'viewed' as const, expiresAt: now - 28 * HOUR + 48 * HOUR, status: 'Pending' as const }
  omarBed.heldBy = offer.id

  // transfer / swap pending
  const transfers = [
    { id: id('T'), kind: 'Transfer' as const, stayId: stays.find(s => s.staffId === meena.id)!.id, destBedId: bedByCode('PV-V06-R1-B').id, reason: 'Wants a quieter room near work shift', requestedBy: meena.id, createdAt: now - 26 * HOUR, status: 'Submitted' as const },
    { id: id('T'), kind: 'Swap' as const, stayId: arunStay.id, otherStayId: bilalStay.id, reason: 'Both work opposite shifts and want to swap rooms', requestedBy: arun.id, createdAt: now - 8 * HOUR, status: 'Submitted' as const },
  ]
  // clearance for the leaver
  const clearances = [{
    id: id('C'), staffId: sunil.id, stayId: sunilStay.id, openedAt: now - 6 * DAY, effective: addDays(T, -6), reason: 'Resigned', status: 'Open' as const,
    items: [
      { id: 'k', label: 'Room and locker keys returned', mandatory: true, owner: 'Reception', status: 'Open' as const },
      { id: 'a', label: 'Assets returned (TV remote, linen)', mandatory: true, owner: 'Reception', status: 'Open' as const },
      { id: 'i', label: 'Room inspection and damage/loss record', mandatory: true, owner: 'Maintenance', status: 'Open' as const },
      { id: 'm', label: 'Open maintenance issues resolved', mandatory: false, owner: 'Maintenance', status: 'Done' as const },
    ],
  }]
  // emergency pending
  const emergencies = [{ id: 'EM1', stayId: imranStay.id, staffId: imran.id, bedId: imranStay.bedId, initiatorId: 'p-rec', initiatorRole: 'Rec' as const, approverRole: 'AA' as const, reason: 'Fire alarm in staff block D, relocated overnight', createdAt: now - 20 * HOUR, status: 'Pending' as const, reminders: 0, escalation: 0 as const }]
  const cleaning = [{ id: id('H'), bedId: nc.id, assignedTo: lakshmi.id, status: 'Open' as const, createdAt: now - 5 * HOUR }, { id: id('H'), bedId: insp.id, assignedTo: lakshmi.id, status: 'Cleaned' as const, cleanedBy: lakshmi.id, createdAt: now - 6 * HOUR }]
  const tasks: State['tasks'] = []
  const workOrders = [
    { id: id('WO'), bedId: blk.id, title: 'Ceiling leak, Villa 03 Room 3', status: 'In progress' as const, assignee: 'CoolAir Services', createdAt: now - 9 * DAY },
    { id: id('WO'), bedId: um.id, title: 'Replace AC compressor', status: 'Open' as const, createdAt: now - 2 * DAY },
    { id: id('WO'), bedId: bedByCode('PV-V02-R2-A').id, title: 'Shower mixer dripping', status: 'Resolved' as const, assignee: 'E9007', createdAt: now - 3 * DAY, resolvedBy: 'E9007' },
    { id: id('WO'), bedId: bedByCode('PV-V07-R2-A').id, title: 'Rewire corridor lights, Villa 07', status: 'In progress' as const, assignee: 'BrightSpark Electrical', createdAt: now - 4 * DAY },
  ]
  const leakWo = workOrders[0], wiringWo = workOrders[3]
  const vendors = [{ id: 'V1', name: 'CoolAir Services' }, { id: 'V2', name: 'BrightSpark Electrical' }]
  const contracts = [
    { id: 'CT1', vendorId: 'V1', from: '2026-01-01', to: '2027-01-01', status: 'Active' as const, docsValidUntil: '2026-12-31' },
    { id: 'CT2', vendorId: 'V2', from: '2026-03-01', to: '2027-03-01', status: 'Active' as const, docsValidUntil: '2026-10-01' },   // worker documents expired
  ]
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 14, h, m)
  const contractorVisits = [
    { id: 'CV1', vendorId: 'V1', workOrderId: leakWo.id, siteId: 'PV', from: at(9), to: at(17), workers: ['Imran K.', 'Salim R.'], escort: 'Sanjay Kumar', status: 'Checked in' as const, checkedInAt: at(9, 5) },
    { id: 'CV2', vendorId: 'V2', workOrderId: wiringWo.id, siteId: 'PV', from: at(13), to: at(16), workers: ['Dinesh P.'], status: 'Scheduled' as const },
    { id: 'CV3', vendorId: 'V1', workOrderId: leakWo.id, siteId: 'PV', from: at(9) + DAY, to: at(17) + DAY, workers: ['Imran K.'], escort: 'Sanjay Kumar', status: 'Scheduled' as const },
  ]
  const visitors = [
    { id: 'VS1', name: 'Fatima Hussain', hostStaffId: rahul.id, purpose: 'Family visit', siteId: 'PV', from: at(15), to: at(18), status: 'Pre-registered' as const, requiresApproval: true, createdBy: 'E1007' },
    { id: 'VS2', name: 'Ali Reza', hostStaffId: tom.id, purpose: 'Collect documents', siteId: 'PV', from: at(10), to: at(12), status: 'Approved' as const, requiresApproval: true, approvedBy: 'Rohan Das', createdBy: 'E9002' },
    { id: 'VS3', name: 'Courier (Aramex)', hostStaffId: lakshmi.id, purpose: 'Parcel delivery', siteId: 'LV', from: at(9, 30), to: at(10), status: 'Walk-in pending' as const, requiresApproval: false, createdBy: 'E9008' },
    { id: 'VS4', name: 'Sana Malik', hostStaffId: meena.id, purpose: 'Friend visit', siteId: 'PV', from: at(7), to: at(9), status: 'Checked in' as const, requiresApproval: false, checkedInAt: at(7, 10), createdBy: 'E9008' },
  ]
  const keys = stays.filter(s => s.status === 'Active').map(s => ({ id: id('K'), bedId: s.bedId, staffId: s.staffId, kind: 'Room key' as const, status: 'Issued' as const, at: now - 30 * DAY }))
  keys.find(k => k.staffId === sunil.id)!.status = 'Issued'

  return {
    seq: n + 100, config: DEFAULT_CONFIG, sites, buildings, rooms, beds, staff, requests, reservations, stays, keys,
    waitlist: [entryNeha, entry2, entry3, entryOmar], offers: [offer], clearances, cleaning, emergencies, tasks, transfers, extensions: [],
    notifications: [
      { id: 'N1', at: now - 28 * HOUR, toStaffId: omar.id, text: 'A bed is offered to you (PV-V04-R3-C). Accept or decline within 48 hours.', email: true },
    ],
    audit: [{ id: 'A0', at: now - 40 * DAY, actor: 'System', action: 'Seed', detail: 'Prototype dataset loaded (dummy data, D-100)' }],
    migration: undefined, delegations: [], visitors, vendors, contracts, contractorVisits, outage: undefined, offlineEvents: [],
    changes: [], overrides: {}, accounts: {}, exports: [], emailProviderUp: true, incidents: [
      { id: id('I'), kind: 'Incident', bedId: bedByCode('PV-V02-R2-A').id, text: 'Loud noise reported after midnight', at: now - 2 * DAY, ackAt: now - 2 * DAY + 600000, ackBy: 'E9008', closed: true },
    ], workOrders,
  }
}
