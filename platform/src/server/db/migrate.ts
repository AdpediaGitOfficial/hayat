import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

/**
 * Plain SQL migrations (db/migrations/NNNN_name.sql) applied in order.
 * - each file runs in its own transaction together with its schema_migrations row, so a failure leaves nothing half-applied
 * - re-running is a no-op; a changed, already-applied file is an error (fix forward with a new migration)
 * - an advisory lock serialises concurrent runners (two app instances starting together)
 */

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/
const LOCK_KEY = 7_265_001 // arbitrary, unique to this app

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db/migrations')

export interface MigrationFile { name: string; sql: string; checksum: string }
export interface MigrateResult { applied: string[]; skipped: string[] }

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()
  const files: MigrationFile[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const m = FILE_RE.exec(name)
    if (!m) throw new Error(`Migration "${name}" must be named NNNN_snake_case.sql`)
    if (seen.has(m[1])) throw new Error(`Two migrations share the number ${m[1]}`)
    seen.add(m[1])
    const sql = await readFile(path.join(dir, name), 'utf8')
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') })
  }
  return files
}

export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR, log: (msg: string) => void = () => {}): Promise<MigrateResult> {
  const files = await readMigrations(dir)
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  const result: MigrateResult = { applied: [], skipped: [] }
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows
        .map(r => [r.name, r.checksum]),
    )
    for (const f of files) {
      const prev = done.get(f.name)
      if (prev !== undefined) {
        if (prev !== f.checksum) throw new Error(`Migration ${f.name} was changed after it was applied. Add a new migration instead.`)
        result.skipped.push(f.name)
        continue
      }
      await client.query('BEGIN')
      try {
        await client.query(f.sql)
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${f.name} failed and was rolled back: ${(err as Error).message}`)
      }
      log(`applied ${f.name}`)
      result.applied.push(f.name)
    }
    return result
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    await client.end()
  }
}
