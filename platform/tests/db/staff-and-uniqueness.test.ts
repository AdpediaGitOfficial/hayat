import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { claimPeriod } from '@/domain/claims'
import { newBed, newClaim, newPool, newStaff, one, pgError, uniq } from './helpers'

const UNIQUE_VIOLATION = '23505'

let pool: Pool
beforeAll(() => { pool = newPool() })
afterAll(() => pool.end())

describe('employee ID is the unique business key (D-05)', () => {
  it("' e1007 ' and 'E1007' are the same employee: the second insert is rejected", async () => {
    const base = uniq('E').toUpperCase()
    await newStaff(pool, ` ${base.toLowerCase()} `)
    const err = await pgError(newStaff(pool, base))
    expect(err.code).toBe(UNIQUE_VIOLATION)
    expect(err.constraint).toBe('staff_employee_id_norm')
  })

  it('rejects a blank employee ID', async () => {
    const err = await pgError(newStaff(pool, '   '))
    expect(err.code).toBe('23514')
  })

  it('different IDs coexist, and the primary key is a uuid that does not change when the ID is corrected', async () => {
    const a = uniq('E')
    const id = await newStaff(pool, a)
    await newStaff(pool, uniq('E'))
    await pool.query(`UPDATE staff_profile SET employee_id = $2 WHERE id = $1`, [id, a + '-fixed'])
    const row = await one<{ id: string; employee_id: string }>(pool, `SELECT id, employee_id FROM staff_profile WHERE id = $1`, [id])
    expect(row).toEqual({ id, employee_id: a + '-fixed' })
  })

  it('an update that would collide after normalisation is rejected too', async () => {
    const a = uniq('E')
    const b = uniq('E')
    await newStaff(pool, a)
    const idB = await newStaff(pool, b)
    const err = await pgError(pool.query(`UPDATE staff_profile SET employee_id = $2 WHERE id = $1`, [idB, `  ${a.toUpperCase()}`]))
    expect(err.code).toBe(UNIQUE_VIOLATION)
  })

  it('email is optional (D-06) and usernames are unique case-insensitively', async () => {
    const staffId = await newStaff(pool)
    expect((await one<{ email: string | null }>(pool, `SELECT email FROM staff_profile WHERE id = $1`, [staffId])).email).toBeNull()
    const username = uniq('user')
    await pool.query(`INSERT INTO user_account (username) VALUES ($1)`, [username])
    const err = await pgError(pool.query(`INSERT INTO user_account (username) VALUES ($1)`, [` ${username.toUpperCase()} `]))
    expect(err.code).toBe(UNIQUE_VIOLATION)
  })
})

describe('one active stay and one active offer per person', () => {
  async function stayOn(staffId: string, status = 'active') {
    const { bedId } = await newBed(pool)
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01'), 'stay')
    const checkout = status === 'checked_out' || status === 'closed' ? 'now()' : 'NULL'
    const closed = status === 'closed' ? 'now()' : 'NULL'
    return one<{ id: string }>(pool,
      `INSERT INTO stay (staff_id, bed_id, claim_id, status, stay_type, checked_out_at, closed_at)
       VALUES ($1, $2, $3, $4, 'permanent', ${checkout}, ${closed}) RETURNING id`, [staffId, bedId, claimId, status])
  }

  it('a second active stay for the same person is rejected, even on another bed', async () => {
    const staffId = await newStaff(pool)
    await stayOn(staffId)
    const err = await pgError(stayOn(staffId))
    expect(err.code).toBe(UNIQUE_VIOLATION)
    expect(err.constraint).toBe('one_active_stay_per_staff')
  })

  it('provisional and resolution-pending stays still count as occupying a bed', async () => {
    const staffId = await newStaff(pool)
    await stayOn(staffId, 'provisional')
    expect((await pgError(stayOn(staffId, 'active'))).constraint).toBe('one_active_stay_per_staff')
  })

  it('a person with an ended stay can be checked in again', async () => {
    const staffId = await newStaff(pool)
    await stayOn(staffId, 'checked_out')
    await stayOn(staffId, 'closed')
    await expect(stayOn(staffId, 'active')).resolves.toBeTruthy()
  })

  async function offerFor(staffId: string, status = 'pending') {
    const { bedId } = await newBed(pool)
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'), 'offer_hold')
    return one<{ id: string }>(pool,
      `INSERT INTO bed_offer (staff_id, bed_id, claim_id, status) VALUES ($1, $2, $3, $4) RETURNING id`, [staffId, bedId, claimId, status])
  }

  it('a second pending offer for the same person is rejected; finished offers do not count', async () => {
    const staffId = await newStaff(pool)
    await offerFor(staffId, 'declined')
    await offerFor(staffId, 'expired')
    const first = await offerFor(staffId)
    const err = await pgError(offerFor(staffId))
    expect(err.constraint).toBe('one_active_offer_per_staff')
    await pool.query(`UPDATE bed_offer SET status = 'declined' WHERE id = $1`, [first.id])
    await expect(offerFor(staffId)).resolves.toBeTruthy()
  })

  it('an offer hold also blocks the bed against an overlapping request', async () => {
    const staffId = await newStaff(pool)
    const { bedId } = await newBed(pool)
    const claimId = await newClaim(pool, bedId, claimPeriod('2026-11-01', '2026-11-30'), 'offer_hold')
    await pool.query(`INSERT INTO bed_offer (staff_id, bed_id, claim_id) VALUES ($1, $2, $3)`, [staffId, bedId, claimId])
    expect((await pgError(newClaim(pool, bedId, claimPeriod('2026-11-15', '2026-12-15')))).code).toBe('23P01')
  })
})
