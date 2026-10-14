import { randomUUID } from 'node:crypto'
import { Client, Pool, type QueryResult, type QueryResultRow } from 'pg'
import { inject } from 'vitest'

/** Anything that can run a query: a Pool, a Client, or a transaction's client. */
export interface Q {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

export const dbUrl = () => inject('dbUrl')
export const appDbUrl = () => inject('appDbUrl')
export const adminUrl = () => inject('adminUrl')

export function newPool(url = dbUrl()) {
  return new Pool({ connectionString: url, max: 8 })
}

export async function newClient(url = dbUrl()) {
  const c = new Client({ connectionString: url })
  await c.connect()
  return c
}

/** Unique text so parallel test files never collide on business keys. */
export const uniq = (prefix = 'x') => `${prefix}-${randomUUID().slice(0, 8)}`

export async function one<T extends QueryResultRow = QueryResultRow>(q: Q, text: string, values: unknown[] = []): Promise<T> {
  const r = await q.query<T>(text, values)
  if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}: ${text}`)
  return r.rows[0]
}

/** Resolves to the Postgres error (code + message) a statement raises, or fails the test if it succeeds. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string; constraint?: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code?: string; message: string; constraint?: string }
    if (!err.code) throw e
    return { code: err.code, message: err.message, constraint: err.constraint }
  }
  throw new Error('expected the statement to fail, but it succeeded')
}

/* ---------------- row factories (each call creates its own isolated graph) ---------------- */

export async function newSite(q: Q) {
  return (await one<{ id: string }>(q, `INSERT INTO site (code, name, kind) VALUES ($1, $2, 'villa') RETURNING id`, [uniq('S'), 'Test site'])).id
}

/** Site -> room -> bed. A villa-style graph: no building, floor or unit. */
export async function newBed(q: Q, state = 'available') {
  const siteId = await newSite(q)
  const roomId = (await one<{ id: string }>(q, `INSERT INTO room (site_id, name) VALUES ($1, $2) RETURNING id`, [siteId, uniq('R')])).id
  const archivedAt = state === 'archived' ? 'now()' : 'NULL'
  const bedId = (await one<{ id: string }>(q,
    `INSERT INTO bed (site_id, room_id, code, state, archived_at) VALUES ($1, $2, $3, $4, ${archivedAt}) RETURNING id`,
    [siteId, roomId, uniq('B'), state])).id
  return { siteId, roomId, bedId }
}

export async function newStaff(q: Q, employeeId = uniq('E')) {
  return (await one<{ id: string }>(q,
    `INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [employeeId, 'Test Person'])).id
}

export async function newClaim(q: Q, bedId: string, period: string, kind: 'reservation' | 'offer_hold' | 'stay' = 'reservation') {
  return (await one<{ id: string }>(q,
    `INSERT INTO bed_claim (bed_id, kind, period) VALUES ($1, $2, $3::daterange) RETURNING id`, [bedId, kind, period])).id
}

export async function newReservation(q: Q, staffId: string, bedId: string, claimId: string) {
  return (await one<{ id: string }>(q,
    `INSERT INTO reservation (staff_id, bed_id, claim_id, eta, source, stay_type)
     VALUES ($1, $2, $3, now(), 'request', 'contract') RETURNING id`, [staffId, bedId, claimId])).id
}
