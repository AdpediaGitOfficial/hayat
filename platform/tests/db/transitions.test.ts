import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { BED_STATES, CLAIM_KINDS, RESERVATION_STATUSES, STAY_STATUSES } from '@/domain/enums'
import { BED_TRANSITIONS, CLAIM_KIND_TRANSITIONS, MACHINES, RESERVATION_TRANSITIONS, STAY_TRANSITIONS, canTransition } from '@/domain/transitions'
import { claimPeriod } from '@/domain/claims'
import { newBed, newClaim, newPool, newReservation, newStaff, one, pgError } from './helpers'

const ILLEGAL_TRANSITION = 'GH001'

let pool: Pool
beforeAll(() => { pool = newPool() })
afterAll(() => pool.end())

describe('the state_transition table equals the pure state machines in src/domain', () => {
  it('has exactly the same moves', async () => {
    const rows = (await pool.query<{ entity: string; from_state: string; to_state: string }>(
      `SELECT entity, from_state, to_state FROM state_transition`)).rows
    const inDb = new Set(rows.map(r => `${r.entity}:${r.from_state}->${r.to_state}`))
    const inCode = new Set<string>()
    for (const [entity, machine] of Object.entries(MACHINES)) {
      for (const [from, tos] of Object.entries(machine)) for (const to of tos) inCode.add(`${entity}:${from}->${to}`)
    }
    expect([...inDb].sort()).toEqual([...inCode].sort())
  })
})

describe('bed.state: illegal jumps are rejected by the database', () => {
  it('Occupied -> Available directly is refused; the bed stays Occupied', async () => {
    const { bedId } = await newBed(pool, 'occupied')
    const err = await pgError(pool.query(`UPDATE bed SET state = 'available' WHERE id = $1`, [bedId]))
    expect(err.code).toBe(ILLEGAL_TRANSITION)
    expect(err.message).toContain('occupied -> available')
    expect((await one<{ state: string }>(pool, `SELECT state FROM bed WHERE id = $1`, [bedId])).state).toBe('occupied')
  })

  it('the only road back to Available is Needs Cleaning -> Inspection Required -> Available', async () => {
    const { bedId } = await newBed(pool, 'occupied')
    const move = (to: string) => pool.query(`UPDATE bed SET state = $2 WHERE id = $1`, [bedId, to])
    await move('needs_cleaning')
    expect((await pgError(move('available'))).code).toBe(ILLEGAL_TRANSITION)   // cleaning is not an inspection
    await move('inspection_required')
    await move('available')
  })

  it('a failed final inspection sends the bed back to cleaning', async () => {
    const { bedId } = await newBed(pool, 'inspection_required')
    await pool.query(`UPDATE bed SET state = 'needs_cleaning' WHERE id = $1`, [bedId])
  })

  it('an occupied bed cannot be blocked (residents are flagged, never auto-moved), and archived is final', async () => {
    const occ = await newBed(pool, 'occupied')
    expect((await pgError(pool.query(`UPDATE bed SET state = 'blocked' WHERE id = $1`, [occ.bedId]))).code).toBe(ILLEGAL_TRANSITION)
    const arch = await newBed(pool, 'archived')
    expect((await pgError(pool.query(`UPDATE bed SET state = 'available', archived_at = NULL WHERE id = $1`, [arch.bedId]))).code).toBe(ILLEGAL_TRANSITION)
  })

  it('a no-op write of the same state is not a transition', async () => {
    const { bedId } = await newBed(pool, 'occupied')
    await pool.query(`UPDATE bed SET state = 'occupied', state_reason = 'noted' WHERE id = $1`, [bedId])
  })

  it('every one of the 7 x 7 state pairs behaves exactly as BED_TRANSITIONS says', async () => {
    for (const from of BED_STATES) {
      for (const to of BED_STATES) {
        if (from === to) continue
        const { bedId } = await newBed(pool, from)
        const attempt = pool.query(`UPDATE bed SET state = $2, archived_at = CASE WHEN $2 = 'archived' THEN now() END WHERE id = $1`, [bedId, to])
        if (canTransition(BED_TRANSITIONS, from, to)) await attempt
        else expect((await pgError(attempt)).code, `${from} -> ${to}`).toBe(ILLEGAL_TRANSITION)
      }
    }
  })
})

describe('stay.status', () => {
  async function stayIn(status: string) {
    const staffId = await newStaff(pool)
    const { bedId } = await newBed(pool, 'occupied')
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01'), 'stay')
    const out = status === 'checked_out' || status === 'closed'
    return (await one<{ id: string }>(pool,
      `INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_out_at, closed_at)
       VALUES ($1, $2, $3, $4, 'permanent', ${out ? 'now()' : 'NULL'}, ${status === 'closed' ? 'now()' : 'NULL'}) RETURNING id`,
      [staffId, bedId, claimId, status])).id
  }
  const set = (id: string, to: string) => pool.query(
    `UPDATE stay SET status = $2, checked_out_at = coalesce(checked_out_at, now()), closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE closed_at END WHERE id = $1`, [id, to])

  it('Active -> Closed is refused: checkout and clearance are separate steps', async () => {
    const id = await stayIn('active')
    expect((await pgError(set(id, 'closed'))).code).toBe(ILLEGAL_TRANSITION)
    await set(id, 'checked_out')
    await set(id, 'closed')
  })

  it('a closed stay can never come back', async () => {
    const id = await stayIn('closed')
    for (const to of ['active', 'checked_out', 'provisional']) {
      expect((await pgError(set(id, to))).code, to).toBe(ILLEGAL_TRANSITION)
    }
  })

  it('all 5 x 5 status pairs behave exactly as STAY_TRANSITIONS says', async () => {
    for (const from of STAY_STATUSES) {
      for (const to of STAY_STATUSES) {
        if (from === to) continue
        const id = await stayIn(from)
        const attempt = set(id, to)
        if (canTransition(STAY_TRANSITIONS, from, to)) await attempt
        else expect((await pgError(attempt)).code, `${from} -> ${to}`).toBe(ILLEGAL_TRANSITION)
      }
    }
  })
})

describe('reservation.status and bed_claim.kind', () => {
  it('a cancelled reservation cannot be revived; every pair matches RESERVATION_TRANSITIONS', async () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        if (from === to) continue
        const staffId = await newStaff(pool)
        const { bedId } = await newBed(pool)
        const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'))
        const id = await newReservation(pool, staffId, bedId, claimId)
        if (from !== 'reserved') {
          // 'reserved' is the only legal starting point; reach other states by the legal route, then try the pair.
          await pool.query(`UPDATE reservation SET status = $2 WHERE id = $1`, [id, from])
        }
        const attempt = pool.query(`UPDATE reservation SET status = $2 WHERE id = $1`, [id, to])
        if (canTransition(RESERVATION_TRANSITIONS, from, to)) await attempt
        else expect((await pgError(attempt)).code, `${from} -> ${to}`).toBe(ILLEGAL_TRANSITION)
      }
    }
  })

  it('a claim converts offer_hold -> reservation -> stay and never backwards; every pair matches CLAIM_KIND_TRANSITIONS', async () => {
    for (const from of CLAIM_KINDS) {
      for (const to of CLAIM_KINDS) {
        if (from === to) continue
        const { bedId } = await newBed(pool)
        const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'), from)
        const attempt = pool.query(`UPDATE bed_claim SET kind = $2 WHERE id = $1`, [claimId, to])
        if (canTransition(CLAIM_KIND_TRANSITIONS, from, to)) await attempt
        else expect((await pgError(attempt)).code, `${from} -> ${to}`).toBe(ILLEGAL_TRANSITION)
      }
    }
  })
})
