import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>

let pool: Pool | undefined

/** One pool per process, created on first use so `next build` never needs a database. */
export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000 })
    // An idle client erroring (e.g. server restart) must not crash the process.
    pool.on('error', err => console.error('pg pool error', err.message))
  }
  return pool
}

export function getDb(): Db {
  return drizzle(getPool(), { schema })
}

export type DbHealth = { ok: true; latencyMs: number } | { ok: false; error: string }

export async function checkDb(): Promise<DbHealth> {
  const t0 = Date.now()
  try {
    await getPool().query('SELECT 1')
    return { ok: true, latencyMs: Date.now() - t0 }
  } catch (err) {
    // Message only: connection strings can contain credentials.
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}
