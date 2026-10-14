/**
 * AT-019 and the rules around Mark as Left (D-35 to D-38, D-03, D-26, D-27): login and sessions end at once, a clearance case opens,
 * the stay and the bed are NOT touched, the cascade of D-36 runs, everything is one transaction.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, PASSWORD, signIn } from '../harness'
import { POST as loginRoute } from '../../../app/api/v1/auth/login/route'
import { GET as meRoute } from '../../../app/api/v1/auth/me/route'
import { POST as markLeftRoute } from '../../../app/api/v1/exit/route'
import { markLeft, type MarkLeftOut } from '@/server/commands/exit/markLeft'
import { rcFor } from '../rc'
import { checkIn } from '@/server/commands/stays/checkIn'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import {
  accountRow, auditFor, bedState, busyResident, caseOf, claimRow, clockAt, eventsOf, itemsOf, liveSessions, mkItem, mkReservation, notifs, resident, snapshot, staffRow, status, stayRow, who, world,
} from './helpers'

afterAll(closeAll)

const input = (staffId: string, extra: Partial<{ effectiveDate: string; reason: string; confirmPassword: string }> = {}) =>
  ({ staffId, effectiveDate: '2026-10-14', reason: 'Resigned, last day today', confirmPassword: PASSWORD, ...extra })

describe('AT-019: an Accommodation Admin marks an occupied resident as Left', () => {
  it('ends the login and the session at once, opens the clearance case, and leaves the stay and the bed exactly as they were', async () => {
    const w = await world()
    const b = await busyResident(w)
    const { r } = b
    // the resident is signed in and can use the system right now
    expect((await call(meRoute, { cookie: r.cookie })).status).toBe(200)
    expect(await liveSessions(r.user.id)).toBe(1)

    const res = await call(markLeftRoute, { cookie: w.aa.cookie, body: input(r.staffId), path: '/api/v1/exit' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const out = res.body.data as MarkLeftOut
    expect(out).toMatchObject({ staffId: r.staffId, stillInBed: true, accountRevoked: true, sessionsEnded: 1, stayId: r.stayId, siteId: w.siteId, repeated: false })

    // login and session: dead on the very next request, and sign-in is refused
    expect((await call(meRoute, { cookie: r.cookie })).status).toBe(401)
    expect(await liveSessions(r.user.id)).toBe(0)
    expect((await call(loginRoute, { body: { username: r.user.username, password: r.user.password } })).status).toBe(401)
    expect(await accountRow(r.user.id)).toMatchObject({ status: 'revoked' })
    expect((await accountRow(r.user.id)).revoked_at).not.toBeNull()
    expect(await staffRow(r.staffId)).toMatchObject({ employment_status: 'left', left_effective: '2026-10-14' })

    // the stay and the bed are untouched: the resident stays in the bed until an actual checkout (D-35)
    expect(await stayRow(r.stayId!)).toMatchObject({ status: 'active', checked_out_at: null })
    expect(await bedState(w.bedIds[0])).toBe('occupied')
    expect((await claimRow(r.claimId!)).released_at).toBeNull()

    // the clearance case, with the configured checklist
    const [k] = await caseOf(r.staffId)
    expect(k).toMatchObject({ id: out.caseId, status: 'open', stay_id: r.stayId, site_id: w.siteId, effective_date: '2026-10-14', reason: 'Resigned, last day today', opened_by: w.aa.user.id })
    expect((await itemsOf(k.id)).map(i => [i.checklist_key, i.mandatory, i.owner, i.status])).toEqual([
      ['belongings', true, 'Reception', 'open'], ['inspection', true, 'Maintenance', 'open'], ['loss_record', false, 'AA', 'open'],
    ])
    expect((await eventsOf(k.id)).map(e => e.kind)).toEqual(['opened'])

    // the cascade of D-36
    expect(out.cascade).toMatchObject({ offersWithdrawn: 1, waitlistEntriesClosed: 1, requestsCancelled: 1, reservationsCancelled: 1, transfersCancelled: 1, extensionsCancelled: 1, checkoutRequestsCancelled: 1, emergencyConverted: 0 })
    expect(await status('waitlist_entry', b.entry)).toBe('closed')
    expect(await status('bed_offer', b.offer)).toBe('withdrawn')
    expect((await claimRow(b.hold)).released_at).not.toBeNull()
    expect(await status('reservation', b.rsv.reservationId)).toBe('cancelled')
    expect((await claimRow(b.rsv.claimId)).released_at).not.toBeNull()
    expect(await status('accommodation_request', b.req)).toBe('cancelled')
    expect(await status('transfer_request', b.transfer)).toBe('cancelled')
    expect(await status('extension_request', b.ext)).toBe('cancelled')
    expect(await status('checkout_request', b.checkout)).toBe('cancelled')

    // the Policy Approver and Reception at the site are told, once, with event-based keys
    const n = await notifs(`clearance:${k.id}:`)
    expect(n.map(x => [x.dedupe_key.split(':').slice(2).join(':'), x.to_role, x.site_id])).toEqual([['opened:pa', 'PolicyApprover', w.siteId], ['opened:rec', 'Rec', w.siteId]])

    // one audit event with before and after
    const a = (await auditFor(r.staffId)).filter(x => x.action === 'exit.staff.marked_left')
    expect(a).toHaveLength(1)
    expect(a[0].before).toMatchObject({ employmentStatus: 'active', accountStatus: 'active', stayStatus: 'active', bedState: 'occupied' })
    expect(a[0].after).toMatchObject({ employmentStatus: 'left', accountStatus: 'revoked', sessionsEnded: 1, caseId: k.id, stayChanged: false, bedChanged: false, bedFreed: false })
    expect(a[0].actor_role).toBe('AA')
  })

  it('a pending emergency approval becomes part of the clearance case (D-36); the provisional stay is not touched', async () => {
    const w = await world()
    const rec = await who('Rec', { siteIds: [w.siteId], caps: ['EmergencyCheckin'] })
    const person = await resident()
    const e = await initiateEmergency(rec.rc(), { staffId: person.staffId, bedId: w.bedIds[0], reason: 'Fire alarm in block D, relocated overnight' })
    expect(e.ok).toBe(true)
    if (!e.ok) return
    const r = await markLeft(w.aa.rc(), input(person.staffId))
    expect(r.ok && r.data.cascade.emergencyConverted).toBe(1)
    const row = (await admin().query(`SELECT status, conversion_note FROM emergency_checkin WHERE id = $1`, [e.data.caseId])).rows[0]
    expect(row.status).toBe('converted')
    expect(row.conversion_note).toContain((await caseOf(person.staffId))[0].id) // it names the clearance case
    expect(await stayRow(e.data.stayId)).toMatchObject({ status: 'provisional', checked_out_at: null })
    expect(await bedState(w.bedIds[0])).toBe('occupied')
    expect((await caseOf(person.staffId))[0].stay_id).toBe(e.data.stayId)
  })

  it('keys and assets still held become mandatory items of the case; a lost one belongs to the Accommodation Admin', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const held = await mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: r.staffId, code: 'K-HELD' })
    const lost = await mkItem({ siteId: w.siteId, roomId: w.roomId, holderStaffId: r.staffId, status: 'lost', category: 'asset', itemType: 'access_card', code: 'C-LOST' })
    const res = await markLeft(w.aa.rc(), input(r.staffId))
    expect(res.ok && res.data.itemsOpened).toBe(5)
    const items = await itemsOf((await caseOf(r.staffId))[0].id)
    const h = items.find(i => i.handover_item_id === held)!
    const l = items.find(i => i.handover_item_id === lost)!
    expect(h).toMatchObject({ kind: 'handover', mandatory: true, owner: 'Reception', label: 'Room key K-HELD' })
    expect(l).toMatchObject({ kind: 'handover', mandatory: true, owner: 'AA', label: 'Access card C-LOST' })
  })

  it('the due date counts business days of the site calendar from the day it was marked (default 5: Wed 14 Oct -> Wed 21 Oct)', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    await markLeft(w.aa.rc(), input(r.staffId))
    expect((await caseOf(r.staffId))[0].due_date).toBe('2026-10-21')
  })

  it('a person with no stay and no reservation has no site: any holder of the action may act (S-8), and the case has no site', async () => {
    const w = await world()
    const person = await resident()
    const res = await markLeft(w.aa.rc(), input(person.staffId))
    expect(res.ok && res.data).toMatchObject({ siteId: null, stayId: null, stillInBed: false })
    expect((await caseOf(person.staffId))[0]).toMatchObject({ site_id: null, stay_id: null })
    const n = await notifs(`clearance:${(await caseOf(person.staffId))[0].id}:`)
    expect(n.every(x => x.site_id === null)).toBe(true)
    // an AA with no site at all still cannot
    const other = await resident()
    const refused = await markLeft(rcFor(w.aa.user.id, { role: 'AA', sites: [], staffId: w.aa.user.staffId }, clockAt()), input(other.staffId))
    expect(refused).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('a staff member without a login account can be marked Left; there is simply no account to end', async () => {
    const w = await world()
    const { mkStaff } = await import('./helpers')
    const s = await mkStaff()
    const res = await markLeft(w.aa.rc(), input(s.id))
    expect(res.ok && res.data).toMatchObject({ accountRevoked: false, sessionsEnded: 0 })
    expect(await staffRow(s.id)).toMatchObject({ employment_status: 'left' })
  })

  it('works when the effective date is in the future: the record keeps the date, the login still ends now (D-37 is open)', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const res = await markLeft(w.aa.rc(), input(r.staffId, { effectiveDate: '2026-12-31' }))
    expect(res.ok).toBe(true)
    expect(await staffRow(r.staffId)).toMatchObject({ left_effective: '2026-12-31' })
    expect((await call(meRoute, { cookie: r.cookie })).status).toBe(401)
  })
})

describe('re-confirmation of the password (D-03)', () => {
  it('a missing or wrong confirmPassword refuses and changes NOTHING', async () => {
    const w = await world()
    const b = await busyResident(w)
    const before = await snapshot(b.r.staffId, b.r.user.id)
    const missing = await call(markLeftRoute, { cookie: w.aa.cookie, body: input(b.r.staffId, { confirmPassword: undefined }), path: '/api/v1/exit' })
    expect(missing.status).toBe(422)
    const missing2 = await markLeft(w.aa.rc(), { staffId: b.r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned' })
    expect(missing2).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: expect.any(String) } })
    const wrong = await markLeft(w.aa.rc(), input(b.r.staffId, { confirmPassword: 'not-the-password-1' }))
    expect(wrong).toMatchObject({ ok: false, code: 'invalid', fields: { confirmPassword: 'Wrong password' } })
    expect(await snapshot(b.r.staffId, b.r.user.id)).toBe(before)
    expect((await call(meRoute, { cookie: b.r.cookie })).status).toBe(200) // still signed in
  })
})

describe('Mark as Left is all or nothing', () => {
  // A trigger makes one write fail; the whole command must roll back to exactly where it started.
  const points: [string, string, (ids: { staffId: string; userId: string; eid: string }) => string][] = [
    ['the staff update', 'staff_profile', ids => `BEFORE UPDATE ON staff_profile FOR EACH ROW WHEN (NEW.id = '${ids.staffId}' AND NEW.employment_status = 'left')`],
    ['revoking the account', 'user_account', ids => `BEFORE UPDATE ON user_account FOR EACH ROW WHEN (NEW.id = '${ids.userId}' AND NEW.status = 'revoked')`],
    ['ending the sessions', 'session', ids => `BEFORE UPDATE ON session FOR EACH ROW WHEN (NEW.user_id = '${ids.userId}' AND NEW.revoked_at IS NOT NULL)`],
    ['cancelling a reservation', 'reservation', ids => `BEFORE UPDATE ON reservation FOR EACH ROW WHEN (NEW.staff_id = '${ids.staffId}' AND NEW.status = 'cancelled')`],
    ['closing the waitlist entry', 'waitlist_entry', ids => `BEFORE UPDATE ON waitlist_entry FOR EACH ROW WHEN (NEW.staff_id = '${ids.staffId}' AND NEW.status = 'closed')`],
    ['cancelling the request', 'accommodation_request', ids => `BEFORE UPDATE ON accommodation_request FOR EACH ROW WHEN (NEW.staff_id = '${ids.staffId}' AND NEW.status = 'cancelled')`],
    ['cancelling the checkout request', 'checkout_request', ids => `BEFORE UPDATE ON checkout_request FOR EACH ROW WHEN (NEW.staff_id = '${ids.staffId}' AND NEW.status = 'cancelled')`],
    ['opening the clearance case', 'clearance_case', ids => `BEFORE INSERT ON clearance_case FOR EACH ROW WHEN (NEW.staff_id = '${ids.staffId}')`],
    ['the audit event', 'audit_event', ids => `BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.entity_id = '${ids.staffId}' AND NEW.action = 'exit.staff.marked_left')`],
    ['the LAST step, the notification to Reception', 'notification', ids => `BEFORE INSERT ON notification FOR EACH ROW WHEN (NEW.text LIKE '%${ids.eid}%' AND NEW.kind = 'exit.clearance_opened')`],
  ]
  it.each(points)('a failure at %s leaves staff, account, sessions, claims, waitlist and requests exactly as they were', async (_name, table, when) => {
    const w = await world()
    const b = await busyResident(w)
    const ids = { staffId: b.r.staffId, userId: b.r.user.id, eid: b.r.employeeId }
    const before = await snapshot(b.r.staffId, b.r.user.id)
    const fn = `gh_fail_${Math.random().toString(36).slice(2, 10)}`
    await admin().query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`)
    await admin().query(`CREATE TRIGGER ${fn} ${when(ids)} EXECUTE FUNCTION ${fn}()`)
    try {
      const res = await markLeft(w.aa.rc(), input(b.r.staffId))
      expect(res.ok).toBe(false)
      expect(res).toMatchObject({ code: 'internal' })
    } finally {
      await admin().query(`DROP TRIGGER ${fn} ON ${table}`)
      await admin().query(`DROP FUNCTION ${fn}()`)
    }
    expect(await snapshot(b.r.staffId, b.r.user.id)).toBe(before)
    expect((await call(meRoute, { cookie: b.r.cookie })).status).toBe(200) // the session is alive: nothing was half-done
    expect(await caseOf(b.r.staffId)).toHaveLength(0)
    expect(await notifs(`clearance:`).then(rows => rows.filter(n => n.text.includes(b.r.employeeId)))).toHaveLength(0)
    // and a clean retry works
    expect((await markLeft(w.aa.rc(), input(b.r.staffId))).ok).toBe(true)
  })
})

describe('repeat calls and concurrent calls', () => {
  it('the same call twice returns the existing case and changes nothing more', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const first = await markLeft(w.aa.rc(), input(r.staffId))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await markLeft(w.aa.rc(), input(r.staffId))
    expect(second.ok && second.data).toMatchObject({ caseId: first.data.caseId, repeated: true })
    expect(await caseOf(r.staffId)).toHaveLength(1)
    expect((await auditFor(r.staffId)).filter(a => a.action === 'exit.staff.marked_left')).toHaveLength(1)
    expect(await notifs(`clearance:${first.data.caseId}:`)).toHaveLength(2)
  })

  it('a different call for someone already Left is refused and points at the case', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    const first = await markLeft(w.aa.rc(), input(r.staffId))
    const second = await markLeft(w.sa.rc(), input(r.staffId, { reason: 'Another reason' }))
    expect(second).toMatchObject({ ok: false, code: 'conflict', detail: { reason: 'already_left', caseId: first.ok ? first.data.caseId : '' } })
    expect(!second.ok && second.next).toMatch(/clearance case/)
  })

  it('two admins marking the same person at the same moment: one case, one audit event', async () => {
    const w = await world()
    const aa2 = await who('AA', { siteIds: [w.siteId] })
    const r = await resident({ bedId: w.bedIds[0] })
    const [x, y] = await Promise.all([markLeft(w.aa.rc(), input(r.staffId)), markLeft(aa2.rc(), input(r.staffId, { reason: 'Same person, other admin' }))])
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1)
    expect(await caseOf(r.staffId)).toHaveLength(1)
    expect((await auditFor(r.staffId)).filter(a => a.action === 'exit.staff.marked_left')).toHaveLength(1)
  })
})

describe('Mark as Left racing a check-in', () => {
  it('either the check-in wins (the stay is on the case, still active) or Mark as Left wins (the reservation is cancelled and check-in refused): never a stay nobody knows about', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world()
      const person = await resident()
      const rsv = await mkReservation({ bedId: w.bedIds[0], staffId: person.staffId, from: '2026-10-14', to: null })
      const [inn, left] = await Promise.all([
        checkIn(w.rec.rc(), { reservationId: rsv.reservationId }),
        markLeft(w.aa.rc(), input(person.staffId)),
      ])
      expect(left.ok, JSON.stringify(left)).toBe(true)
      const k = (await caseOf(person.staffId))[0]
      const stays = (await admin().query<{ id: string; status: string }>(`SELECT id, status FROM stay WHERE staff_id = $1`, [person.staffId])).rows
      if (inn.ok) {
        expect(stays).toHaveLength(1)
        expect(k.stay_id).toBe(stays[0].id) // the case knows about the stay: flagged, not released
        expect(stays[0].status).toBe('active')
        expect(await bedState(w.bedIds[0])).toBe('occupied')
      } else {
        expect(stays).toHaveLength(0)
        expect(k.stay_id).toBeNull()
        expect(await status('reservation', rsv.reservationId)).toBe('cancelled')
        expect(await bedState(w.bedIds[0])).toBe('available')
      }
    }
  })
})

describe('separation of duties, scope and who may', () => {
  it('nobody marks themselves as Left (D-26), and nothing changes', async () => {
    const w = await world()
    const before = await snapshot(w.aa.user.staffId, w.aa.user.id)
    const r = await markLeft(w.aa.rc(), input(w.aa.user.staffId))
    expect(r).toMatchObject({ ok: false, code: 'separation_of_duties' })
    expect(await snapshot(w.aa.user.staffId, w.aa.user.id)).toBe(before)
  })

  it('an Accommodation Admin of site A gets "not found" for a resident at site B', async () => {
    const w = await world()
    const r = await resident({ bedId: w.other.bedIds[0] })
    const before = await snapshot(r.staffId, r.user.id)
    expect(await markLeft(w.aa.rc(), input(r.staffId))).toMatchObject({ ok: false, code: 'not_found', status: 404 })
    const viaRoute = await call(markLeftRoute, { cookie: w.aa.cookie, body: input(r.staffId), path: '/api/v1/exit' })
    expect(viaRoute.status).toBe(404)
    expect(await snapshot(r.staffId, r.user.id)).toBe(before)
    // the AA of site B can
    expect((await markLeft(w.aaOther.rc(), input(r.staffId))).ok).toBe(true)
  })

  it('Reception, a Maintenance Coordinator and a resident cannot mark anyone as Left (403 before the body is read)', async () => {
    const w = await world()
    const r = await resident({ bedId: w.bedIds[0] })
    for (const p of [w.rec, w.mc]) {
      const res = await call(markLeftRoute, { cookie: p.cookie, body: input(r.staffId), path: '/api/v1/exit' })
      expect(res.status).toBe(403)
    }
    expect((await call(markLeftRoute, { cookie: r.cookie, body: input(r.staffId), path: '/api/v1/exit' })).status).toBe(403)
    expect(await caseOf(r.staffId)).toHaveLength(0)
  })

  it('an administrator account is a Super Admin to end: an AA cannot mark another AA as Left, a Super Admin can', async () => {
    const w = await world()
    const colleague = await who('AA', { siteIds: [w.siteId] })
    // the colleague also lives at the site, so the AA has scope over the person
    await mkStayForColleague(w, colleague.user.staffId)
    const refused = await markLeft(w.aa.rc(), input(colleague.user.staffId))
    expect(refused).toMatchObject({ ok: false, code: 'forbidden', owner: 'Super Admin' })
    expect((await markLeft(w.sa.rc(), input(colleague.user.staffId))).ok).toBe(true)
  })
})

async function mkStayForColleague(w: Awaited<ReturnType<typeof world>>, staffId: string) {
  const { mkStayFor } = await import('./helpers')
  await mkStayFor({ staffId, bedId: w.bedIds[5], from: '2026-10-01' })
}
