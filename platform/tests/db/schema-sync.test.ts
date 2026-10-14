import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  BED_STATES, CAPABILITIES, CLAIM_KINDS, GRANT_STATUSES, OFFER_STATUSES, REQUEST_STATUSES, RESERVATION_STATUSES, ROLES,
  SCOPE_KINDS, STAY_STATUSES, STAY_TYPES, WAITLIST_STATUSES,
} from '@/domain/enums'
import { TABLES } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { dbUrl, newPool } from './helpers'

let pool: Pool
beforeAll(() => { pool = newPool() })
afterAll(() => pool.end())

describe('Drizzle table definitions match the migrated database', () => {
  it('every table and every column exists on both sides (SQL migrations are the source of truth)', async () => {
    const rows = (await pool.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`)).rows
    const inDb = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!inDb.has(r.table_name)) inDb.set(r.table_name, new Set())
      inDb.get(r.table_name)!.add(r.column_name)
    }
    const inCode = new Map<string, Set<string>>()
    for (const t of Object.values(TABLES)) {
      const cfg = getTableConfig(t)
      inCode.set(cfg.name, new Set(cfg.columns.map(c => c.name)))
    }
    // state_transition is reference data managed by migrations only; it is deliberately not a typed table.
    inDb.delete('state_transition')
    expect([...inCode.keys()].sort()).toEqual([...inDb.keys()].sort())
    for (const [table, cols] of inDb) expect([...inCode.get(table)!].sort(), table).toEqual([...cols].sort())
  })

  it('the typed client reads and writes through the real schema', async () => {
    const prev = process.env.DATABASE_URL
    process.env.DATABASE_URL = dbUrl()
    try {
      const { site } = await import('@/server/db/schema')
      const db = getDb()
      const [row] = await db.insert(site).values({ code: `DZ-${Math.random().toString(36).slice(2, 8)}`, name: 'Drizzle site', kind: 'villa' }).returning()
      expect(row.kind).toBe('villa')
      expect(row.createdAt).toBeInstanceOf(Date)
    } finally {
      const { getPool } = await import('@/server/db/client')
      await getPool().end()
      process.env.DATABASE_URL = prev
    }
  })
})

describe('enum lists in src/domain/enums.ts equal the CHECK constraints in the database', () => {
  const cases: [table: string, column: string, values: readonly string[]][] = [
    ['bed', 'state', BED_STATES],
    ['stay', 'status', STAY_STATUSES],
    ['stay', 'stay_type', STAY_TYPES],
    ['reservation', 'status', RESERVATION_STATUSES],
    ['bed_claim', 'kind', CLAIM_KINDS],
    ['accommodation_request', 'status', REQUEST_STATUSES],
    ['accommodation_request', 'stay_type', STAY_TYPES],
    ['bed_offer', 'status', OFFER_STATUSES],
    ['waitlist_entry', 'status', WAITLIST_STATUSES],
    ['role_assignment', 'role', ROLES],
    ['role_assignment', 'scope_kind', SCOPE_KINDS],
    ['capability_grant', 'capability', CAPABILITIES],
    ['capability_grant', 'status', GRANT_STATUSES],
  ]
  it.each(cases)('%s.%s', async (table, column, values) => {
    const defs = (await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`public.${table}`])).rows.map(r => r.def)
    const own = defs.find(d => new RegExp(`^CHECK \\(\\(?${column} = ANY \\(ARRAY\\[`).test(d))
    expect(own, `no enum CHECK on ${table}.${column}`).toBeDefined()
    const inDb = [...own!.matchAll(/'([^']+)'::text/g)].map(m => m[1])
    expect([...inDb].sort()).toEqual([...values].sort())
  })
})
