import { randomBytes } from 'node:crypto'
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, migrate, readMigrations } from '@/server/db/migrate'
import { adminUrl } from './helpers'
import { withDatabase } from './url'

/** Each test here gets its own empty database, so the runner is exercised from scratch. */
let admin: Client
const created: string[] = []
let scratch: string

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl() })
  await admin.connect()
  scratch = await mkdtemp(path.join(tmpdir(), 'gh-migrations-'))
})
afterAll(async () => {
  for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
  await rm(scratch, { recursive: true, force: true })
})

async function freshDb() {
  const name = `gh_platform_mig_${randomBytes(5).toString('hex')}`
  await admin.query(`CREATE DATABASE ${name}`)
  created.push(name)
  return withDatabase(adminUrl(), name)
}

async function copyMigrations(): Promise<string> {
  const dir = await mkdtemp(path.join(scratch, 'm-'))
  await cp(MIGRATIONS_DIR, dir, { recursive: true })
  return dir
}

describe('migration runner', () => {
  it('applies every file in order, then does nothing the second time (idempotent)', async () => {
    const url = await freshDb()
    const files = await readMigrations()
    const first = await migrate(url)
    expect(first.applied).toEqual(files.map(f => f.name))
    expect(first.skipped).toEqual([])
    const second = await migrate(url)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(files.map(f => f.name))
  })

  // Stage 1 reserves number ranges per work package (0010-0019, 0020-0029, 0030-0039), so gaps are expected.
  it('migration files have four-digit numbers that are unique and ascending', async () => {
    const names = (await readdir(MIGRATIONS_DIR)).filter(n => n.endsWith('.sql')).sort()
    const nums = names.map(n => { expect(n).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/); return Number(n.slice(0, 4)) })
    expect(new Set(nums).size).toBe(nums.length)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
  })

  it('a failing migration rolls back completely and records nothing', async () => {
    const url = await freshDb()
    const dir = await copyMigrations()
    await writeFile(path.join(dir, '9999_broken.sql'), `CREATE TABLE half_done (id int); SELECT 1/0;`)
    await expect(migrate(url, dir)).rejects.toThrow(/9999_broken.sql failed and was rolled back/)
    const c = new Client({ connectionString: url })
    await c.connect()
    try {
      expect((await c.query(`SELECT to_regclass('public.half_done') AS t`)).rows[0].t).toBeNull()
      const done = (await c.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map(r => r.name)
      expect(done).not.toContain('9999_broken.sql')
      expect(done.length).toBeGreaterThan(0)   // the good ones before it stay applied
    } finally {
      await c.end()
    }
  })

  it('refuses to continue when an applied migration file has been edited', async () => {
    const url = await freshDb()
    const dir = await copyMigrations()
    await migrate(url, dir)
    await writeFile(path.join(dir, '0001_extensions.sql'), '-- edited\nSELECT 1;')
    await expect(migrate(url, dir)).rejects.toThrow(/changed after it was applied/)
  })

  it('two runners started at once do not collide', async () => {
    const url = await freshDb()
    const [a, b] = await Promise.all([migrate(url), migrate(url)])
    const total = (await readMigrations()).length
    expect(a.applied.length + b.applied.length).toBe(total)
  })

  it('rejects badly named files', async () => {
    const dir = await mkdtemp(path.join(scratch, 'bad-'))
    await writeFile(path.join(dir, 'init.sql'), 'SELECT 1;')
    await expect(readMigrations(dir)).rejects.toThrow(/must be named NNNN_snake_case.sql/)
  })
})
