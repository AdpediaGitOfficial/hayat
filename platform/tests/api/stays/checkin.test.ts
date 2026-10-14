import { afterAll, describe, expect, it } from 'vitest'
import { admin, closeAll } from '../harness'
import {
  auditRows, bedState, claimRow, day, liveClaims, mkBed, mkReservation, mkRoom, mkSite, notificationsFor, person, reservationRowOf, residents, setBedState, stayRow, world,
} from './helpers'
import { bulkCheckIn, checkIn } from '@/server/commands/stays/checkIn'
import { listArrivals } from '@/server/queries/stays/arrivals'
import { FixedClock } from '@/server/clock'

afterAll(closeAll)

const R = (reservationId: string) => ({ reservationId })

describe('check-in (D-59)', () => {
  it('commits the stay, converts the claim, occupies the bed and tells the resident: one transaction', async () => {
    const w = await world()
    const [res] = await residents(1)
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(30) })
    const out = await checkIn(w.rec.rc, R(r.reservationId))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const s = await stayRow(out.data.stayId)
    expect(s).toMatchObject({ status: 'active', bed_id: w.bedIds[0], claim_id: r.claimId, reservation_id: r.reservationId })
    expect((await claimRow(r.claimId)).kind).toBe('stay')
    expect((await reservationRowOf(r.reservationId)).status).toBe('checked_in')
    expect(await bedState(w.bedIds[0])).toBe('occupied')
    expect(await liveClaims(w.bedIds[0])).toHaveLength(1)
    const a = await auditRows(out.data.stayId)
    expect(a.map(x => x.action)).toEqual(['stays.stay.checked_in'])
    expect(a[0].actor_role).toBe('Rec')
    const n = await notificationsFor(out.data.stayId)
    expect(n.map(x => x.kind)).toEqual(['stay.checked_in'])
  })

  it('the reservation can be checked in only once; the second attempt says which stay exists', async () => {
    const w = await world()
    const [res] = await residents(1)
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(30) })
    const first = await checkIn(w.rec.rc, R(r.reservationId))
    const again = await checkIn(w.rec.rc, R(r.reservationId))
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(false)
    if (!again.ok && first.ok) {
      expect(again.code).toBe('conflict')
      expect(again.detail).toMatchObject({ reason: 'already_checked_in', stayId: first.data.stayId })
    }
  })

  it('two simultaneous check-ins for one reservation: exactly one wins, one stay exists', async () => {
    const w = await world()
    const [res] = await residents(1)
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(30) })
    const second = await person('Rec', { siteIds: [w.siteId] })
    const results = await Promise.all([checkIn(w.rec.rc, R(r.reservationId)), checkIn(second.rc, R(r.reservationId))])
    expect(results.filter(x => x.ok)).toHaveLength(1)
    const lost = results.find(x => !x.ok)
    expect(lost && !lost.ok && (lost.detail as { reason: string }).reason).toBe('already_checked_in')
    const stays = (await admin().query(`SELECT id FROM stay WHERE reservation_id = $1`, [r.reservationId])).rows
    expect(stays).toHaveLength(1)
    expect(await bedState(w.bedIds[0])).toBe('occupied')
  })

  it('readiness gates check-in only: a needs-cleaning bed can be reserved, but check-in is refused with reason, owner and next action, then passes once it is Available (STAGE-2 proof 5)', async () => {
    const w = await world()
    await setBedState(w.bedIds[0], 'needs_cleaning')
    const [res] = await residents(1)
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(30) }) // the reservation itself was fine
    const refused = await checkIn(w.rec.rc, R(r.reservationId))
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe('conflict')
      expect(refused.reason).toMatch(/not ready/i)
      expect(refused.owner).toBe('Housekeeping')
      expect(refused.next).toBeTruthy()
      expect(refused.detail).toMatchObject({ reason: 'bed_not_ready', state: 'needs_cleaning' })
    }
    // nothing half-done
    expect((await reservationRowOf(r.reservationId)).status).toBe('reserved')
    expect((await claimRow(r.claimId)).kind).toBe('reservation')
    expect(await bedState(w.bedIds[0])).toBe('needs_cleaning')
    expect((await admin().query(`SELECT 1 FROM stay WHERE staff_id = $1`, [res.staffId])).rowCount).toBe(0)

    await setBedState(w.bedIds[0], 'inspection_required')
    const stillNot = await checkIn(w.rec.rc, R(r.reservationId))
    expect(!stillNot.ok && stillNot.owner).toBe('Final inspection holder')

    await setBedState(w.bedIds[0], 'available')
    expect((await checkIn(w.rec.rc, R(r.reservationId))).ok).toBe(true)
  })

  it('a blocked bed and a bed still occupied by the previous resident are refused with the right owner', async () => {
    const w = await world()
    const [a, b] = await residents(2)
    await setBedState(w.bedIds[0], 'blocked')
    const r1 = await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(0), to: day(10) })
    const blocked = await checkIn(w.rec.rc, R(r1.reservationId))
    expect(!blocked.ok && blocked.detail).toMatchObject({ reason: 'bed_unavailable' })
    expect(!blocked.ok && blocked.owner).toBe('Maintenance Coordinator')

    // same-day arrival while the previous resident has not been checked out: the bed is still Occupied
    await setBedState(w.bedIds[1], 'occupied')
    const r2 = await mkReservation({ bedId: w.bedIds[1], staffId: b.staffId, from: day(0), to: day(10) })
    const occupied = await checkIn(w.rec.rc, R(r2.reservationId))
    expect(!occupied.ok && occupied.detail).toMatchObject({ reason: 'bed_occupied' })
    expect(!occupied.ok && occupied.next).toMatch(/checkout/i)
  })

  it('refuses to check in before the arrival day, and a reservation that is no longer reserved', async () => {
    const w = await world()
    const [a, b] = await residents(2)
    const future = await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(3), to: day(10) })
    const early = await checkIn(w.rec.rc, R(future.reservationId))
    expect(!early.ok && early.detail).toMatchObject({ reason: 'too_early', arrival: day(3) })

    const gone = await mkReservation({ bedId: w.bedIds[1], staffId: b.staffId, from: day(0), to: day(10) })
    await admin().query(`UPDATE reservation SET status = 'cancelled' WHERE id = $1`, [gone.reservationId])
    const closed = await checkIn(w.rec.rc, R(gone.reservationId))
    expect(!closed.ok && closed.detail).toMatchObject({ reason: 'reservation_closed' })
  })

  it('revalidates eligibility at check-in (D-59): a room that became gender-restricted refuses the check-in', async () => {
    const siteId = await mkSite()
    const room = await mkRoom(siteId, { gender: 'any' })
    const bed = await mkBed(room)
    const rec = await person('Rec', { siteIds: [siteId] })
    const [res] = await residents(1)
    await admin().query(`UPDATE staff_profile SET gender = 'male' WHERE id = $1`, [res.staffId])
    const r = await mkReservation({ bedId: bed, staffId: res.staffId, from: day(0), to: day(10) })
    await admin().query(`UPDATE room SET gender_policy = 'female' WHERE id = $1`, [room])
    const refused = await checkIn(rec.rc, R(r.reservationId))
    expect(!refused.ok && refused.detail).toMatchObject({ reason: 'not_eligible', exceptionable: true })
    expect((await reservationRowOf(r.reservationId)).status).toBe('reserved')
  })

  it('one active stay per person: a second check-in names the existing stay', async () => {
    const w = await world()
    const [res] = await residents(1)
    const r1 = await mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: day(0), to: day(10) })
    const r2 = await mkReservation({ bedId: w.bedIds[1], staffId: res.staffId, from: day(0), to: day(10) })
    const first = await checkIn(w.rec.rc, R(r1.reservationId))
    const second = await checkIn(w.rec.rc, R(r2.reservationId))
    expect(first.ok).toBe(true)
    expect(!second.ok && second.detail).toMatchObject({ reason: 'has_active_stay', stayId: first.ok ? first.data.stayId : undefined })
    expect(await bedState(w.bedIds[1])).toBe('available')
  })

  it('SoD (D-26): nobody processes their own check-in', async () => {
    const w = await world()
    const rec = await person('Rec', { siteIds: [w.siteId] })
    const r = await mkReservation({ bedId: w.bedIds[0], staffId: rec.staffId, from: day(0), to: day(10) })
    const refused = await checkIn(rec.rc, R(r.reservationId))
    expect(!refused.ok && refused.code).toBe('separation_of_duties')
    expect(await bedState(w.bedIds[0])).toBe('available')
    // an independent person can
    expect((await checkIn(w.aa.rc, R(r.reservationId))).ok).toBe(true)
  })

  it('scope: Reception of site A gets "not found" for a reservation of site B; a resident cannot check in at all', async () => {
    const a = await world()
    const b = await world()
    const [res] = await residents(1)
    const r = await mkReservation({ bedId: b.bedIds[0], staffId: res.staffId, from: day(0), to: day(10) })
    const out = await checkIn(a.rec.rc, R(r.reservationId))
    expect(!out.ok && out.code).toBe('not_found')
    const resident = await checkIn(res.rc, R(r.reservationId))
    expect(!resident.ok && resident.code).toBe('forbidden')
    expect((await reservationRowOf(r.reservationId)).status).toBe('reserved')
  })
})

describe('bulk check-in (D-60)', () => {
  it('per-row results; one blocked bed does not hold up the others; a retry reports the finished rows as already done', async () => {
    const w = await world({ beds: 3 })
    const [a, b, c] = await residents(3)
    await setBedState(w.bedIds[1], 'needs_cleaning')
    const ra = await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(0), to: day(10) })
    const rb = await mkReservation({ bedId: w.bedIds[1], staffId: b.staffId, from: day(0), to: day(10) })
    const rc = await mkReservation({ bedId: w.bedIds[2], staffId: c.staffId, from: day(0), to: day(10) })
    const ids = [ra.reservationId, rb.reservationId, rc.reservationId]
    const first = await bulkCheckIn(w.rec.rc, { reservationIds: ids })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data).toMatchObject({ checkedIn: 2, alreadyDone: 0, failed: 1 })
    const failed = first.data.rows.find(r => r.outcome === 'failed')
    expect(failed).toMatchObject({ reservationId: rb.reservationId, owner: 'Housekeeping' })

    await setBedState(w.bedIds[1], 'available')
    const retry = await bulkCheckIn(w.rec.rc, { reservationIds: ids })
    expect(retry.ok && retry.data).toMatchObject({ checkedIn: 1, alreadyDone: 2, failed: 0 })
    expect((await admin().query(`SELECT count(*)::int AS n FROM stay WHERE staff_id = ANY($1)`, [[a.staffId, b.staffId, c.staffId]])).rows[0].n).toBe(3)
  })

  it('rows outside the actor\'s scope fail as not found without stopping the batch', async () => {
    const a = await world({ beds: 1 })
    const b = await world({ beds: 1 })
    const [x, y] = await residents(2)
    const mine = await mkReservation({ bedId: a.bedIds[0], staffId: x.staffId, from: day(0), to: day(5) })
    const theirs = await mkReservation({ bedId: b.bedIds[0], staffId: y.staffId, from: day(0), to: day(5) })
    const out = await bulkCheckIn(a.rec.rc, { reservationIds: [theirs.reservationId, mine.reservationId] })
    expect(out.ok && out.data).toMatchObject({ checkedIn: 1, failed: 1 })
    expect(out.ok && out.data.rows[0]).toMatchObject({ outcome: 'failed', code: 'not_found' })
  })
})

describe('arrivals list', () => {
  it('shows today\'s arrival with a not-ready marker, reason, owner and next action; expected ones later; scoped to the site', async () => {
    const w = await world({ beds: 3 })
    const other = await world({ beds: 1 })
    const [a, b, c, d] = await residents(4)
    await setBedState(w.bedIds[0], 'needs_cleaning')
    await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(0), to: day(10) })        // today, bed not ready
    await mkReservation({ bedId: w.bedIds[1], staffId: b.staffId, from: day(0), to: day(10) })        // today, ready
    await setBedState(w.bedIds[2], 'needs_cleaning')
    await mkReservation({ bedId: w.bedIds[2], staffId: c.staffId, from: day(3), to: day(10) })        // later: needs cleaning is fine for now
    await mkReservation({ bedId: other.bedIds[0], staffId: d.staffId, from: day(0), to: day(10) })    // another site
    const rows = await listArrivals(w.rec.rc.actor, { siteId: undefined }, w.rec.rc.clock.now())
    expect(rows.map(r => r.staffId).sort()).toEqual([a.staffId, b.staffId, c.staffId].sort())
    const byStaff = Object.fromEntries(rows.map(r => [r.staffId, r]))
    expect(byStaff[a.staffId]).toMatchObject({ view: 'Not ready', due: true, block: { owner: 'Housekeeping' } })
    expect(byStaff[a.staffId].block?.next).toBeTruthy()
    expect(byStaff[b.staffId]).toMatchObject({ view: 'Expected', due: true })
    expect(byStaff[b.staffId].block).toBeUndefined()
    expect(byStaff[c.staffId]).toMatchObject({ view: 'Expected', due: false })
    expect(rows[0].due).toBe(true) // due first
  })

  it('a reservation past its no-show window reads No-show until the sweep releases the hold', async () => {
    const w = await world({ beds: 1 })
    const [a] = await residents(1)
    await mkReservation({ bedId: w.bedIds[0], staffId: a.staffId, from: day(-2), to: day(10), eta: `${day(-2)}T12:00:00Z` })
    const rows = await listArrivals(w.rec.rc.actor, {}, new FixedClock(Date.UTC(2026, 9, 14, 9, 42)).now())
    expect(rows[0].view).toBe('No-show')
  })
})
