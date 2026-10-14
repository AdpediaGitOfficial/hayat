import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { migrate } from '../../src/server/db/migrate'
import { withDatabase } from '../db/url'

export const E2E_PASSWORD = 'Welcome-GH-2026'

export default async function setup() {
  const port = Number(process.env.E2E_PORT ?? 3120)
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres'
  const suffix = randomBytes(4).toString('hex')
  const dbName = `gh_e2e_${suffix}`
  const login = `gh_e2e_login_${suffix}`
  const pw = randomBytes(10).toString('hex')

  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${dbName}`)
  const ownerUrl = withDatabase(adminUrl, dbName)
  await migrate(ownerUrl)
  await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${pw}' IN ROLE app_role`)
  const appUrl = new URL(ownerUrl); appUrl.username = login; appUrl.password = pw

  // Specs that arrange data directly (beds, capability grants) use the owner connection of this run's database.
  process.env.E2E_DATABASE_URL = ownerUrl

  execFileSync('npx', ['tsx', 'scripts/seed-dev.ts'], { env: { ...process.env, DATABASE_URL: ownerUrl, SEED_PASSWORD: E2E_PASSWORD }, stdio: 'inherit' })

  const server: ChildProcess = spawn('npx', ['next', 'start', '-p', String(port)], {
    env: { ...process.env, DATABASE_URL: appUrl.toString(), NODE_ENV: 'production' }, stdio: 'ignore', detached: true,
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) break } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('the server did not start within 60 s')
    await new Promise(r => setTimeout(r, 500))
  }

  return async () => {
    try { process.kill(-server.pid!, 'SIGTERM') } catch { /* already gone */ }
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.query(`DROP ROLE IF EXISTS ${login}`)
    await admin.end()
  }
}
