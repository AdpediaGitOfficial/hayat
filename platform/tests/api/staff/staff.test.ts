import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, makeUser, newSite, signIn, uniq } from '../harness'
import { api, auditRows, countStaff, person, seedStaff, type Person } from './helpers'
import { SHAPE_KEYS } from '@/server/queries/staff/shapes'
import { duplicateFailure } from '@/server/commands/staff/create'
import { getDb } from '@/server/db/client'
import { newBed, newClaim, newReservation } from '../../db/helpers'
import { GET as list } from '../../../app/api/v1/staff/route'

afterAll(closeAll)

const sorted = (o: object) => Object.keys(o).sort()
const keys = (s: readonly string[]) => [...s].sort()

describe('AT-001 role-based access: the same record in a different shape for each role', () => {
  let site: string
  let target: { id: string; employeeId: string }
  let sa: Person, aa: Person, aud: Person, rec: Person, sec: Person, res: Person, master: Person, mgr: Person, tech: Person
  beforeAll(async () => {
    site = await newSite()
    target = await seedStaff({ fullName: 'Secret Person' })
    ;[sa, aa, aud, rec, sec, res, mgr, tech] = await Promise.all([
      person('SA'), person('AA', { siteId: site }), person('Aud', { siteId: site }), person('Rec', { siteId: site }),
      person('Sec', { siteId: site }), person('Res'), person('Mgr', { siteId: site }), person('Tech', { siteId: site }),
    ])
    master = await person('Rec', { siteId: site, caps: ['StaffMaster'] })
  })

  it('SA, AA, Auditor and a StaffMaster holder see the full profile (exact key set)', async () => {
    for (const p of [sa, aa, aud, master]) {
      const r = await api.get(p, target.id)
      expect(r.status).toBe(200)
      expect(r.body.data.shape).toBe('full')
      expect(sorted(r.body.data.staff)).toEqual(keys(SHAPE_KEYS.full))
      expect(r.body.data.staff.phone).toBe('+971501234567')
    }
  })

  it('Reception gets the minimum: name, ID, department, employment status. Nothing else, not even as a null', async () => {
    const r = await api.get(rec, target.id)
    expect(r.status).toBe(200)
    expect(r.body.data.shape).toBe('minimum')
    expect(sorted(r.body.data.staff)).toEqual(keys(SHAPE_KEYS.minimum))
    const text = JSON.stringify(r.body)
    for (const secret of ['+971501234567', 'secret.person@example.com', '0509998888', 'female']) expect(text).not.toContain(secret)
  })

  it('Security gets identity only', async () => {
    const r = await api.get(sec, target.id)
    expect(r.status).toBe(200)
    expect(r.body.data.shape).toBe('identity')
    expect(sorted(r.body.data.staff)).toEqual(keys(SHAPE_KEYS.identity))
    expect(JSON.stringify(r.body)).not.toContain('Spa') // not even the department
  })

  it('a Resident sees their own record in the own shape', async () => {
    const mine = await api.me(res)
    expect(mine.status).toBe(200)
    expect(mine.body.data.shape).toBe('own')
    expect(sorted(mine.body.data.staff)).toEqual(keys(SHAPE_KEYS.own))
    expect(mine.body.data.staff.id).toBe(res.user.staffId)
    const byId = await api.get(res, res.user.staffId)
    expect(byId.status).toBe(200)
    expect(byId.body.data.staff.id).toBe(res.user.staffId)
  })

  it('a Resident asking for another profile by direct API call gets 404, identical to a record that does not exist, and the attempt is logged', async () => {
    const other = await api.get(res, target.id)
    const ghost = await api.get(res, crypto.randomUUID())
    const junk = await api.get(res, 'not-a-uuid')
    expect(other.status).toBe(404)
    expect({ ...other.body, requestId: 0 }).toEqual({ ...ghost.body, requestId: 0 })
    expect({ ...junk.body, requestId: 0 }).toEqual({ ...ghost.body, requestId: 0 })
    expect(JSON.stringify(other.body)).not.toMatch(/Secret|Spa|971|403|forbidden/i)
    expect(other.body.code).toBe('not_found')

    const logged = await auditRows('staff.view_denied', target.id)
    expect(logged).toHaveLength(1)
    expect(logged[0].actor_user_id).toBe(res.user.id)
    expect(logged[0].actor_role).toBe('Res')
    // no personal data in the event
    expect(JSON.stringify(logged[0])).not.toMatch(/Secret|971|secret\.person|0509998888/)
    expect(logged[0].before).toBeNull()
    expect(logged[0].after).toBeNull()
  })

  it('the denial is written even though the request is refused (it is not part of a rolled-back transaction)', async () => {
    const t = await seedStaff()
    await api.get(res, t.id)
    await api.get(res, t.id)
    expect(await auditRows('staff.view_denied', t.id)).toHaveLength(2)
  })

  it('a Resident cannot find another person by searching either: the list holds only their own record', async () => {
    const r = await api.list(res, `?q=${encodeURIComponent('Secret')}`)
    expect(r.status).toBe(200)
    expect(r.body.data.items).toEqual([])
    const all = await api.list(res)
    expect(all.body.data.items.map((i: { id: string }) => i.id)).toEqual([res.user.staffId])
    expect(all.body.data.shape).toBe('own')
  })

  it('roles with no directory access get 403 on the list and the record', async () => {
    for (const p of [mgr, tech]) {
      expect((await api.list(p)).status).toBe(403)
      expect((await api.get(p, target.id)).status).toBe(403)
    }
    expect((await call(list, { method: 'GET', path: '/api/v1/staff' })).status).toBe(401)
  })

  it('lookup roles must search: the whole directory is not listed to Reception or Security', async () => {
    for (const p of [rec, sec]) {
      const empty = await api.list(p)
      expect(empty.body.data).toMatchObject({ items: [], total: 0, needsSearch: true })
      expect((await api.list(p, '?q=a')).body.data.needsSearch).toBe(true)
    }
    const found = await api.list(rec, `?q=${target.employeeId}`)
    expect(found.body.data.items).toHaveLength(1)
    expect(sorted(found.body.data.items[0])).toEqual(keys(SHAPE_KEYS.minimum))
    const idOnly = await api.list(sec, `?q=${target.employeeId.toLowerCase()}`)
    expect(sorted(idOnly.body.data.items[0])).toEqual(keys(SHAPE_KEYS.identity))
  })

  it('filters cannot probe fields a role does not see (Security filtering by department learns nothing)', async () => {
    const dept = uniq('Dept')
    const t = await seedStaff({ department: dept })
    const viaSec = await api.list(sec, `?q=${t.employeeId}&department=${encodeURIComponent('Nonexistent')}`)
    expect(viaSec.body.data.items).toHaveLength(1) // the department filter is ignored for Security
    const viaRec = await api.list(rec, `?q=${t.employeeId}&department=${encodeURIComponent('Nonexistent')}`)
    expect(viaRec.body.data.items).toHaveLength(0)
  })

  it('an admin with no site assigned has no directory access at all (capabilities and roles never widen scope)', async () => {
    const user = await makeUser({ roles: [{ role: 'AA' }] }) // an AA assignment with no site
    const p: Person = { user, cookie: await signIn(user) }
    expect((await api.list(p)).status).toBe(403)
    expect((await api.get(p, target.id)).status).toBe(403)
    const w = await api.create(p, { employeeId: uniq('NS'), fullName: 'No Site' })
    expect(w.status).toBe(403)
    expect(w.body.reason).toMatch(/no site is assigned/)
  })
})

describe('AT-001 listing: search, filters, paging', () => {
  let sa: Person
  const tag = uniq('Zq').replace(/-/g, '')
  beforeAll(async () => {
    sa = await person('SA')
    for (let i = 0; i < 7; i++) {
      await admin().query(`INSERT INTO staff_profile (employee_id, full_name, department, employment_status${i === 6 ? ', archived_at' : ''}) VALUES ($1, $2, $3, $4${i === 6 ? ', now()' : ''})`,
        [`${tag}-${i}`, `${tag} Person ${String.fromCharCode(65 + i)}`, i % 2 ? 'Spa' : 'Laundry', i === 5 ? 'left' : 'active'])
    }
  })

  it('searches name and employee ID, case-insensitively; archived are hidden unless asked', async () => {
    const byName = await api.list(sa, `?q=${tag.toUpperCase()}`)
    expect(byName.body.data.total).toBe(6)
    const byId = await api.list(sa, `?q=${tag.toLowerCase()}-3`)
    expect(byId.body.data.items.map((i: { employeeId: string }) => i.employeeId)).toEqual([`${tag}-3`])
    const withArchived = await api.list(sa, `?q=${tag}&includeArchived=true`)
    expect(withArchived.body.data.total).toBe(7)
  })

  it('wildcards in the search text are literal', async () => {
    expect((await api.list(sa, `?q=${encodeURIComponent('%')}`)).body.data.total).toBe(0)
    expect((await api.list(sa, `?q=${encodeURIComponent(tag + '_')}`)).body.data.total).toBe(0)
  })

  it('filters by department and status, and pages in a stable order', async () => {
    expect((await api.list(sa, `?q=${tag}&department=spa`)).body.data.total).toBe(3) // i = 1, 3, 5 are Spa; 6 (Laundry) is archived
    expect((await api.list(sa, `?q=${tag}&status=left`)).body.data.total).toBe(1)
    const p1 = await api.list(sa, `?q=${tag}&limit=4`)
    const p2 = await api.list(sa, `?q=${tag}&limit=4&offset=4`)
    expect(p1.body.data.items).toHaveLength(4)
    expect(p2.body.data.items).toHaveLength(2)
    const names = [...p1.body.data.items, ...p2.body.data.items].map((i: { fullName: string }) => i.fullName)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(6)
    expect((await api.list(sa, `?q=${tag}&limit=100000`)).body.data.limit).toBe(100)
  })
})

describe('AT-003 duplicate staff ID', () => {
  let sa: Person
  beforeAll(async () => { sa = await person('SA') })

  it('creates a profile, audits it in the same transaction, and returns the full record', async () => {
    const id = uniq('N')
    const r = await api.create(sa, { employeeId: `  ${id}  `, fullName: '  Maya   Lopez ', gender: 'Female', department: 'Spa', grade: 3, phone: '+971 50 123 4567', email: 'Maya@Example.com', emergencyContact: 'Ana Lopez', joiningDate: '2026-10-01' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ employeeId: id, fullName: 'Maya Lopez', gender: 'female', grade: 3, email: 'maya@example.com', source: 'manual', employmentStatus: 'active' })
    const a = await auditRows('staff.created', r.body.data.id)
    expect(a).toHaveLength(1)
    expect(a[0].actor_user_id).toBe(sa.user.id)
    expect(JSON.stringify(a[0].after)).not.toMatch(/971|maya@|Ana Lopez/) // contact details are not copied into the log
  })

  it('AT-003 a duplicate is blocked with a clear message naming the existing ID, whatever the case or spacing; nothing is created or merged', async () => {
    const id = uniq('DUP')
    const first = await api.create(sa, { employeeId: id, fullName: 'First Holder' })
    expect(first.status).toBe(200)
    for (const variant of [id, id.toLowerCase(), ` ${id.toUpperCase()} `]) {
      const r = await api.create(sa, { employeeId: variant, fullName: 'Someone Else', department: 'Changed' })
      expect(r.status).toBe(409)
      expect(r.body.reason).toContain(`Employee ID ${id} already exists`)
      expect(r.body.reason).toContain('First Holder') // SA may view the directory, so the holder is named
      expect(r.body.reason).toMatch(/never created|never merged/)
      expect(r.body.fields).toEqual({ employeeId: 'Already in use' })
      expect(r.body.next).toBeTruthy()
      expect(r.body.detail).toEqual({ existingStaffId: first.body.data.id })
    }
    expect(await countStaff(id)).toBe(1)
    const row = (await admin().query(`SELECT full_name, department FROM staff_profile WHERE id = $1`, [first.body.data.id])).rows[0]
    expect(row).toEqual({ full_name: 'First Holder', department: null }) // the existing record is untouched
    expect(await auditRows('staff.created', first.body.data.id)).toHaveLength(1)
  })

  it('an archived profile still owns its employee ID', async () => {
    const id = uniq('ARCH')
    const first = await api.create(sa, { employeeId: id, fullName: 'Old Timer' })
    expect((await api.archive(sa, first.body.data.id)).status).toBe(200)
    const again = await api.create(sa, { employeeId: id, fullName: 'New Hire' })
    expect(again.status).toBe(409)
    expect(again.body.reason).toContain('archived')
  })

  it('only someone who may view the directory is told whose record holds the ID', async () => {
    const id = uniq('PRIV')
    const first = await api.create(sa, { employeeId: id, fullName: 'Hidden Holder' })
    const sec = { role: 'Sec', caps: [], sites: ['x'] } as const
    const f = await duplicateFailure({ tx: getDb() as never, actor: sec }, id.toLowerCase())
    expect(f.reason).toContain(`Employee ID ${id} already exists`)
    expect(f.reason).not.toContain('Hidden Holder')
    expect(f.detail).toBeUndefined()
    const sa2 = { role: 'SA', caps: [], sites: 'all' } as const
    const g = await duplicateFailure({ tx: getDb() as never, actor: sa2 }, id.toLowerCase())
    expect(g.reason).toContain('Hidden Holder')
    expect(g.detail).toEqual({ existingStaffId: first.body.data.id })
  })

  it('two simultaneous creates with the same employee ID: exactly one wins', async () => {
    const id = uniq('RACE')
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => api.create(sa, { employeeId: i % 2 ? id.toLowerCase() : id, fullName: `Racer ${i}` })))
    expect(rs.filter(r => r.status === 200)).toHaveLength(1)
    expect(rs.filter(r => r.status === 409)).toHaveLength(7)
    expect(await countStaff(id)).toBe(1)
    const winner = rs.find(r => r.status === 200)!
    expect(await auditRows('staff.created', winner.body.data.id)).toHaveLength(1)
  })

  it('validates fields with a message per field and writes nothing', async () => {
    const before = Number((await admin().query(`SELECT count(*) FROM audit_event WHERE action = 'staff.created'`)).rows[0].count)
    const r = await api.create(sa, { employeeId: 'bad id', fullName: '', gender: 'x', grade: -1, phone: 'abc', email: 'nope', joiningDate: '2026-02-30' })
    expect(r.status).toBe(422)
    expect(Object.keys(r.body.fields).sort()).toEqual(['email', 'employeeId', 'fullName', 'gender', 'grade', 'joiningDate', 'phone'])
    const formula = await api.create(sa, { employeeId: uniq('F'), fullName: '=HYPERLINK("http://evil","x")' })
    expect(formula.status).toBe(422)
    expect(formula.body.fields.fullName).toMatch(/formula/)
    const huge = await api.create(sa, { employeeId: uniq('H'), fullName: 'x'.repeat(500) })
    expect(huge.body.fields.fullName).toMatch(/too long/)
    const after = Number((await admin().query(`SELECT count(*) FROM audit_event WHERE action = 'staff.created'`)).rows[0].count)
    expect(after).toBe(before)
  })

  it('only roles that manage staff can create (403), and out-of-scope capability-less roles stay out', async () => {
    const site = await newSite()
    for (const role of ['Rec', 'Sec', 'Res', 'Aud', 'Mgr'] as const) {
      const p = await person(role, { siteId: site })
      expect((await api.create(p, { employeeId: uniq('X'), fullName: 'Nope' })).status, role).toBe(403)
    }
    const aa = await person('AA', { siteId: site })
    expect((await api.create(aa, { employeeId: uniq('AAX'), fullName: 'By AA' })).status).toBe(200)
    const master = await person('Rec', { siteId: site, caps: ['StaffMaster'] })
    expect((await api.create(master, { employeeId: uniq('SMX'), fullName: 'By StaffMaster' })).status).toBe(200)
  })
})

describe('update and archive', () => {
  let sa: Person, aa: Person
  beforeAll(async () => { sa = await person('SA'); aa = await person('AA') })

  it('updates the editable fields, audits only what changed, and never changes the employee ID', async () => {
    const t = await api.create(sa, { employeeId: uniq('U'), fullName: 'Edit Me', department: 'Spa', phone: '+971500000001' })
    const id = t.body.data.id as string
    const r = await api.patch(aa, id, { employeeId: 'HACK-1', fullName: 'Edited Name', department: null, phone: '+971500000002', grade: '5' })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ employeeId: t.body.data.employeeId, fullName: 'Edited Name', department: null, grade: 5 })
    const a = await auditRows('staff.updated', id)
    expect(a).toHaveLength(1)
    expect(a[0].before).toEqual({ fullName: 'Edit Me', department: 'Spa', phone: '[set]', grade: null })
    expect(a[0].after).toEqual({ fullName: 'Edited Name', department: null, phone: '[set]', grade: 5 })
    // saving the same values again changes nothing and writes no audit event
    const same = await api.patch(aa, id, { fullName: 'Edited Name' })
    expect(same.status).toBe(200)
    expect(await auditRows('staff.updated', id)).toHaveLength(1)
    // a rule violation changes nothing
    expect((await api.patch(aa, id, { fullName: 'Fine', email: 'bad' })).status).toBe(422)
    expect((await admin().query(`SELECT full_name FROM staff_profile WHERE id = $1`, [id])).rows[0].full_name).toBe('Edited Name')
  })

  it('refuses editing your own record (separation of duties), an unknown id, and a non-uuid id', async () => {
    const self = await api.patch(aa, aa.user.staffId, { department: 'Mine' })
    expect(self.status).toBe(403)
    expect(self.body.code).toBe('separation_of_duties')
    expect((await api.patch(aa, crypto.randomUUID(), { department: 'x' })).status).toBe(404)
    expect((await api.patch(aa, 'nope', { department: 'x' })).status).toBe(404)
  })

  it('an archived profile is read-only', async () => {
    const t = await api.create(sa, { employeeId: uniq('AR'), fullName: 'To Archive' })
    expect((await api.archive(sa, t.body.data.id, { reason: 'Left the group' })).status).toBe(200)
    const e = await api.patch(sa, t.body.data.id, { department: 'x' })
    expect(e.status).toBe(409)
    const a = await auditRows('staff.archived', t.body.data.id)
    expect(a).toHaveLength(1)
    expect(a[0].reason).toBe('Left the group')
    expect((await api.archive(sa, t.body.data.id)).status).toBe(409) // already archived
    const row = (await admin().query(`SELECT archived_at FROM staff_profile WHERE id = $1`, [t.body.data.id])).rows[0]
    expect(row.archived_at).not.toBeNull()
  })

  it('archive needs a reason, cannot be done to yourself, and is refused for non-managers', async () => {
    const t = await api.create(sa, { employeeId: uniq('AR2'), fullName: 'Reasonless' })
    expect((await api.archive(sa, t.body.data.id, { reason: '' })).status).toBe(422)
    const self = await api.archive(aa, aa.user.staffId)
    expect(self.status).toBe(403)
    const rec = await person('Rec')
    expect((await api.archive(rec, t.body.data.id)).status).toBe(403)
  })

  it('archive is refused while the person has a live stay or reservation, and the refusal lists each blocker with owner and next action', async () => {
    const t = await api.create(sa, { employeeId: uniq('BLK'), fullName: 'Has A Bed' })
    const id = t.body.data.id as string
    const { bedId } = await newBed(admin())
    const claim = await newClaim(admin(), bedId, '[2026-11-01,2026-11-20)')
    await newReservation(admin(), id, bedId, claim)
    const r1 = await api.archive(sa, id)
    expect(r1.status).toBe(409)
    expect(r1.body.reason).toMatch(/live reservation/)
    expect(r1.body.owner).toBeTruthy()
    expect(r1.body.next).toBeTruthy()
    expect(r1.body.detail.blockers.map((b: { kind: string }) => b.kind)).toEqual(['reservation'])

    const { bedId: bed2 } = await newBed(admin())
    const stayClaim = await newClaim(admin(), bed2, '[2026-10-01,)', 'stay')
    await admin().query(`INSERT INTO stay (staff_id, bed_id, claim_id, stay_type) VALUES ($1, $2, $3, 'contract')`, [id, bed2, stayClaim])
    const r2 = await api.archive(sa, id)
    expect(r2.status).toBe(409)
    expect(r2.body.detail.blockers.map((b: { kind: string }) => b.kind).sort()).toEqual(['reservation', 'stay'])
    expect((await admin().query(`SELECT archived_at FROM staff_profile WHERE id = $1`, [id])).rows[0].archived_at).toBeNull()
    expect(await auditRows('staff.archived', id)).toHaveLength(0)

    // closing the stay and cancelling the reservation clears the way
    await admin().query(`UPDATE stay SET status = 'checked_out', checked_out_at = now() WHERE staff_id = $1`, [id])
    expect((await api.archive(sa, id)).status).toBe(409) // checked out is not closed: clearance is still open
    await admin().query(`UPDATE stay SET status = 'closed', closed_at = now() WHERE staff_id = $1`, [id])
    await admin().query(`UPDATE reservation SET status = 'cancelled' WHERE staff_id = $1`, [id])
    expect((await api.archive(sa, id)).status).toBe(200)
  })

  it('archive is refused while the person can still sign in', async () => {
    const holder = await person('Res')
    const r = await api.archive(sa, holder.user.staffId)
    expect(r.status).toBe(409)
    expect(r.body.detail.blockers[0]).toMatchObject({ kind: 'account' })
  })
})
