import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, Pool } from 'pg'
import { claimPeriod } from '@/domain/claims'
import { overlaps } from '@/domain/rules'
import { addDays } from '@/domain/time'
import { newBed, newClaim, newClient, newPool, newStaff, one, pgError, type Q } from './helpers'

const EXCLUSION_VIOLATION = '23P01'
const DEADLOCK = '40P01'

let pool: Pool
beforeAll(() => { pool = newPool() })
afterAll(() => pool.end())

describe('bed_claim: a bed never has two overlapping live claims', () => {
  it('rejects an overlapping claim on the same bed', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, '[2026-11-01,2026-11-11)')
    const err = await pgError(newClaim(pool, bedId, '[2026-11-10,2026-11-20)'))
    expect(err.code).toBe(EXCLUSION_VIOLATION)
    expect(err.constraint).toBe('no_double_allocation')
  })

  it('rejects a claim fully inside another, and an identical one', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, '[2026-11-01,2026-12-01)')
    expect(await pgError(newClaim(pool, bedId, '[2026-11-05,2026-11-06)'))).toMatchObject({ code: EXCLUSION_VIOLATION })
    expect(await pgError(newClaim(pool, bedId, '[2026-11-01,2026-12-01)'))).toMatchObject({ code: EXCLUSION_VIOLATION })
  })

  it('rejects a different kind of claim too: reservation, offer hold and stay all compete for the same bed', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, '[2026-11-01,2026-11-11)', 'offer_hold')
    expect(await pgError(newClaim(pool, bedId, '[2026-11-05,2026-11-15)', 'reservation'))).toMatchObject({ code: EXCLUSION_VIOLATION })
    expect(await pgError(newClaim(pool, bedId, '[2026-11-05,2026-11-15)', 'stay'))).toMatchObject({ code: EXCLUSION_VIOLATION })
  })

  it('allows adjacent periods: one stay ends 10 Nov (inclusive), the next starts 11 Nov', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-10'))
    await newClaim(pool, bedId, claimPeriod('2026-11-11', '2026-11-20'))
    const { n } = await one<{ n: string }>(pool, `SELECT count(*) AS n FROM bed_claim WHERE bed_id = $1`, [bedId])
    expect(Number(n)).toBe(2)
  })

  it('treats a shared last day as a conflict (inclusive end dates)', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-10'))
    expect((await pgError(newClaim(pool, bedId, claimPeriod('2026-11-10', '2026-11-20'))))).toMatchObject({ code: EXCLUSION_VIOLATION })
  })

  it('allows the same dates on a different bed', async () => {
    const a = await newBed(pool)
    const b = await newBed(pool)
    await newClaim(pool, a.bedId, '[2026-11-01,2026-11-11)')
    await expect(newClaim(pool, b.bedId, '[2026-11-01,2026-11-11)')).resolves.toBeTruthy()
  })

  it('an open-ended stay blocks every later reservation, but not earlier ones', async () => {
    const { bedId } = await newBed(pool)
    await newClaim(pool, bedId, claimPeriod('2026-11-01'), 'stay')
    expect((await pgError(newClaim(pool, bedId, claimPeriod('2027-06-01', '2027-06-30'))))).toMatchObject({ code: EXCLUSION_VIOLATION })
    expect((await pgError(newClaim(pool, bedId, claimPeriod('2030-01-01'))))).toMatchObject({ code: EXCLUSION_VIOLATION })
    await expect(newClaim(pool, bedId, claimPeriod('2026-10-01', '2026-10-31'))).resolves.toBeTruthy()
  })

  it('a released claim stops blocking the bed but stays as history (no deletion)', async () => {
    const { bedId } = await newBed(pool)
    const first = await newClaim(pool, bedId, '[2026-11-01,2026-11-11)')
    await pool.query(`UPDATE bed_claim SET released_at = now(), release_reason = 'cancelled' WHERE id = $1`, [first])
    await expect(newClaim(pool, bedId, '[2026-11-01,2026-11-11)')).resolves.toBeTruthy()
    const { n } = await one<{ n: string }>(pool, `SELECT count(*) AS n FROM bed_claim WHERE bed_id = $1`, [bedId])
    expect(Number(n)).toBe(2)
  })

  it('rejects empty and unbounded-start periods', async () => {
    const { bedId } = await newBed(pool)
    expect((await pgError(newClaim(pool, bedId, 'empty'))).constraint).toBe('claim_period_valid')
    expect((await pgError(newClaim(pool, bedId, '(,2026-11-01)'))).constraint).toBe('claim_period_valid')
  })

  it('extending a stay into another reservation is refused (UPDATE is covered, not only INSERT)', async () => {
    const { bedId } = await newBed(pool)
    const stay = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-10'), 'stay')
    await newClaim(pool, bedId, claimPeriod('2026-11-15', '2026-11-20'))
    const err = await pgError(pool.query(`UPDATE bed_claim SET period = $2::daterange WHERE id = $1`, [stay, claimPeriod('2026-11-01', '2026-11-16')]))
    expect(err.code).toBe(EXCLUSION_VIOLATION)
  })
})

describe('concurrent allocation (AT-008): two connections, one winner', () => {
  it('two transactions inserting overlapping claims: exactly one commits, the loser gets 23P01', async () => {
    const { bedId } = await newBed(pool)
    const a = await newClient()
    const b = await newClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      await a.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-12-01,2026-12-11)')`, [bedId])
      // B's insert must wait for A's outcome, because A's uncommitted row conflicts.
      const bInsert = b.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-12-05,2026-12-15)')`, [bedId])
        .then(() => 'ok' as const, (e: { code?: string }) => e.code ?? 'error')
      await waitUntilBlocked(pool, b)
      await a.query('COMMIT')
      expect(await bInsert).toBe(EXCLUSION_VIOLATION)
      await b.query('ROLLBACK')
    } finally {
      await a.end()
      await b.end()
    }
    const { n } = await one<{ n: string }>(pool, `SELECT count(*) AS n FROM bed_claim WHERE bed_id = $1`, [bedId])
    expect(Number(n)).toBe(1)
  })

  it('if the first transaction rolls back, the waiting second one succeeds', async () => {
    const { bedId } = await newBed(pool)
    const a = await newClient()
    const b = await newClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')
      await a.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-12-01,2026-12-11)')`, [bedId])
      const bInsert = b.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2026-12-05,2026-12-15)')`, [bedId])
      await waitUntilBlocked(pool, b)
      await a.query('ROLLBACK')
      await bInsert
      await b.query('COMMIT')
    } finally {
      await a.end()
      await b.end()
    }
    const { n } = await one<{ n: string }>(pool, `SELECT count(*) AS n FROM bed_claim WHERE bed_id = $1`, [bedId])
    expect(Number(n)).toBe(1)
  })

  // Two transactions that insert at the same instant can each wait for the other's uncommitted row.
  // Postgres then breaks the tie itself: one commits, the other fails with exclusion_violation (23P01) or
  // deadlock_detected (40P01). Either way there is exactly one winner; the app treats both as "bed taken".
  async function race(bedCount: number, lockBedFirst: boolean) {
    const beds = await Promise.all(Array.from({ length: bedCount }, () => newBed(pool)))
    const racers = await Promise.all(Array.from({ length: bedCount * 2 }, () => newClient()))
    try {
      const attempts = beds.flatMap((b, i) => [0, 1].map(k => {
        const c = racers[i * 2 + k]
        return (async (): Promise<{ outcome: 'won' | 'lost'; code?: string }> => {
          await c.query('BEGIN')
          try {
            // The command protocol of PLAN section 7: lock the bed row, then re-check and write.
            if (lockBedFirst) await c.query('SELECT id FROM bed WHERE id = $1 FOR UPDATE', [b.bedId])
            await c.query(`INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, 'reservation', '[2027-01-01,2027-01-08)')`, [b.bedId])
            await c.query('SELECT pg_sleep(0.05)')   // widen the window in which both transactions are in flight
            await c.query('COMMIT')
            return { outcome: 'won' }
          } catch (e) {
            await c.query('ROLLBACK')
            return { outcome: 'lost', code: (e as { code?: string }).code }
          }
        })()
      }))
      const results = await Promise.all(attempts)
      for (const b of beds) {
        const { n } = await one<{ n: string }>(pool, `SELECT count(*) AS n FROM bed_claim WHERE bed_id = $1`, [b.bedId])
        expect(Number(n)).toBe(1)
      }
      return results
    } finally {
      await Promise.all(racers.map(c => c.end()))
    }
  }

  it('20 beds, 2 racing transactions each, no explicit lock: exactly one winner per bed, the loser fails 23P01 or 40P01', async () => {
    const results = await race(20, false)
    expect(results.filter(r => r.outcome === 'won')).toHaveLength(20)
    const losers = results.filter(r => r.outcome === 'lost')
    expect(losers).toHaveLength(20)
    for (const l of losers) expect([EXCLUSION_VIOLATION, DEADLOCK]).toContain(l.code)
  })

  it('with the bed row locked first (how commands will work), the loser always gets a clean 23P01, never a deadlock', async () => {
    for (let round = 0; round < 3; round++) {
      const results = await race(15, true)
      expect(results.filter(r => r.outcome === 'won')).toHaveLength(15)
      for (const l of results.filter(r => r.outcome === 'lost')) expect(l.code).toBe(EXCLUSION_VIOLATION)
    }
  })
})

describe('the domain overlap rule and the database constraint agree', () => {
  it('overlaps() equals the exclusion constraint for every pair in a window grid', async () => {
    const base = '2026-11-10'
    const windows: { from: string; to?: string }[] = []
    for (const f of [-3, 0, 2, 5]) {
      for (const len of [0, 1, 4, undefined]) {
        const from = addDays(base, f)
        windows.push({ from, to: len === undefined ? undefined : addDays(from, len) })
      }
    }
    for (const a of windows) {
      for (const b of windows) {
        const { bedId } = await newBed(pool)
        await newClaim(pool, bedId, claimPeriod(a.from, a.to))
        const dbConflict = await pgError(newClaim(pool, bedId, claimPeriod(b.from, b.to))).then(e => e.code === EXCLUSION_VIOLATION, () => false)
        expect(dbConflict, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(overlaps(a, b))
      }
    }
  })
})

describe('reservation -> stay conversion keeps a single claim', () => {
  it('check-in converts the claim in place: one claim row, reservation and stay both point at it', async () => {
    const { bedId } = await newBed(pool)
    const staffId = await newStaff(pool)
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'))
    const reservationId = await insertReservation(pool, staffId, bedId, claimId)

    const c = await newClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE bed_claim SET kind = 'stay' WHERE id = $1`, [claimId])
      await c.query(`UPDATE reservation SET status = 'checked_in' WHERE id = $1`, [reservationId])
      await c.query(`INSERT INTO stay (staff_id, bed_id, claim_id, reservation_id, stay_type) VALUES ($1, $2, $3, $4, 'contract')`,
        [staffId, bedId, claimId, reservationId])
      await c.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
      await c.query('COMMIT')
    } finally {
      await c.end()
    }

    const claims = await pool.query(`SELECT id, kind FROM bed_claim WHERE bed_id = $1`, [bedId])
    expect(claims.rows).toEqual([{ id: claimId, kind: 'stay' }])
    const stay = await one<{ claim_id: string; reservation_id: string; status: string }>(pool, `SELECT claim_id, reservation_id, status FROM stay WHERE staff_id = $1`, [staffId])
    expect(stay).toMatchObject({ claim_id: claimId, reservation_id: reservationId, status: 'active' })
    expect((await one<{ status: string }>(pool, `SELECT status FROM reservation WHERE id = $1`, [reservationId])).status).toBe('checked_in')
  })

  it('an interrupted check-in leaves the original reservation, claim and bed untouched', async () => {
    const { bedId } = await newBed(pool)
    const staffId = await newStaff(pool)
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'))
    const reservationId = await insertReservation(pool, staffId, bedId, claimId)

    const c = await newClient()
    try {
      await c.query('BEGIN')
      await c.query(`UPDATE bed_claim SET kind = 'stay' WHERE id = $1`, [claimId])
      await c.query(`UPDATE reservation SET status = 'checked_in' WHERE id = $1`, [reservationId])
      await c.query(`INSERT INTO stay (staff_id, bed_id, claim_id, reservation_id, stay_type) VALUES ($1, $2, $3, $4, 'contract')`,
        [staffId, bedId, claimId, reservationId])
      // The last step fails: occupied -> available is an illegal jump, so the whole check-in must vanish.
      await c.query(`UPDATE bed SET state = 'occupied' WHERE id = $1`, [bedId])
      const err = await pgError(c.query(`UPDATE bed SET state = 'available' WHERE id = $1`, [bedId]))
      expect(err.code).toBe('GH001')
      await c.query('ROLLBACK')
    } finally {
      await c.end()
    }

    expect((await one<{ kind: string }>(pool, `SELECT kind FROM bed_claim WHERE id = $1`, [claimId])).kind).toBe('reservation')
    expect((await one<{ status: string }>(pool, `SELECT status FROM reservation WHERE id = $1`, [reservationId])).status).toBe('reserved')
    expect((await pool.query(`SELECT 1 FROM stay WHERE staff_id = $1`, [staffId])).rowCount).toBe(0)
    expect((await one<{ state: string }>(pool, `SELECT state FROM bed WHERE id = $1`, [bedId])).state).toBe('available')
  })

  it('a stay and a reservation cannot be bound to a claim on a different bed', async () => {
    const a = await newBed(pool)
    const b = await newBed(pool)
    const staffId = await newStaff(pool)
    const claimOnA = await newClaim(pool, a.bedId, claimPeriod('2026-11-01', '2026-11-30'))
    const err = await pgError(insertReservation(pool, staffId, b.bedId, claimOnA))
    expect(err.code).toBe('23503')
  })
})

function insertReservation(q: Q, staffId: string, bedId: string, claimId: string) {
  return one<{ id: string }>(q,
    `INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type)
     VALUES ($1, $2, $3, now(), 'request', 'contract') RETURNING id`, [staffId, bedId, claimId]).then(r => r.id)
}

/** Polls pg_stat_activity until the given connection is waiting on a lock, so the race is real, not assumed. */
async function waitUntilBlocked(observer: Pool, blocked: Client) {
  const pid = (blocked as unknown as { processID: number }).processID
  for (let i = 0; i < 100; i++) {
    const r = await observer.query(`SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid])
    if (r.rowCount) return
    await new Promise(res => setTimeout(res, 20))
  }
  throw new Error('second transaction never blocked on the first one')
}
