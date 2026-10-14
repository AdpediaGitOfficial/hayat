/// <reference types="vite/client" />
/**
 * A private database for tests that count global things (active Super Admins) or change global settings (the
 * configuration registry). The shared test database is used by every test file at once, so those tests could not
 * be deterministic there. Do NOT import ../harness in a file that imports this: the harness points the pool at the
 * shared database.
 *
 * Usage (top of the test file):   const iso = await createIsolated()   // sets DATABASE_URL before any query runs
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { inject } from 'vitest'
import { hashPassword } from '@/server/auth/password'
import { migrate } from '@/server/db/migrate'
import { FixedClock } from '@/server/clock'
import { resetClock, setClock } from '@/server/runtime'
import { withDatabase } from '../../db/url'
import type { Role } from '@/domain/enums'

export const PASSWORD = 'Correct-horse-9'

export interface Isolated {
  admin: Pool
  /** Create a user (optionally with roles). `status` defaults to active. */
  makeUser(o?: { roles?: { role: Role; all?: boolean; siteId?: string }[]; status?: string }): Promise<{ id: string; username: string; staffId: string; password: string }>
  newSite(): Promise<string>
  /** Make every existing Super Admin inactive, so a test starts from a known number of active ones. */
  retireSuperAdmins(): Promise<void>
  activeSuperAdmins(): Promise<number>
  close(): Promise<void>
}

export async function createIsolated(): Promise<Isolated> {
  const adminUrl = inject('adminUrl')
  const suffix = randomBytes(5).toString('hex')
  const dbName = `gh_platform_iso_${suffix}`
  const login = `gh_iso_login_${suffix}`
  const pw = randomBytes(12).toString('hex')
  const server = new Client({ connectionString: adminUrl })
  await server.connect()
  await server.query(`CREATE DATABASE ${dbName}`)
  const ownerUrl = withDatabase(adminUrl, dbName)
  await migrate(ownerUrl)
  await server.query(`CREATE ROLE ${login} LOGIN PASSWORD '${pw}' IN ROLE app_role`)
  const appUrl = new URL(ownerUrl); appUrl.username = login; appUrl.password = pw
  process.env.DATABASE_URL = appUrl.toString()

  const admin = new Pool({ connectionString: ownerUrl, max: 4 })
  // DROP DATABASE ... WITH (FORCE) terminates every connection to it; a pool or client noticing that is expected, not an error.
  admin.on('error', () => undefined)
  server.on('error', () => undefined)
  const hash = await hashPassword(PASSWORD)
  const iso: Isolated = {
    admin,
    async makeUser(o = {}) {
      const username = `u-${randomUUID().slice(0, 8)}`
      const staff = await admin.query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [`E-${username}`, `Person ${username}`])
      const u = await admin.query<{ id: string }>(
        `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, false, $4) RETURNING id`,
        [staff.rows[0].id, username, hash, o.status ?? 'active'])
      for (const r of o.roles ?? []) {
        const kind = r.all ? 'all' : r.siteId ? 'site' : r.role === 'Res' ? 'own' : 'job'
        await admin.query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [u.rows[0].id, r.role, kind, r.siteId ?? null])
      }
      return { id: u.rows[0].id, username, staffId: staff.rows[0].id, password: PASSWORD }
    },
    async newSite() {
      return (await admin.query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, 'Iso site', 'villa') RETURNING id`, [`S-${randomUUID().slice(0, 8)}`])).rows[0].id
    },
    async retireSuperAdmins() {
      await admin.query(`UPDATE user_account SET status = 'revoked', revoked_at = now() WHERE id IN (SELECT user_id FROM role_assignment WHERE role = 'SA' AND revoked_at IS NULL)`)
    },
    async activeSuperAdmins() {
      return (await admin.query<{ n: number }>(
        `SELECT count(DISTINCT u.id)::int AS n FROM user_account u JOIN role_assignment r ON r.user_id = u.id
         WHERE r.role = 'SA' AND r.scope_kind = 'all' AND r.revoked_at IS NULL AND u.status = 'active' AND u.revoked_at IS NULL`)).rows[0].n
    },
    async close() {
      await admin.end()
      const { getPool } = await import('@/server/db/client')
      await getPool().end()
      resetClock()
      await server.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
      await server.query(`DROP ROLE IF EXISTS ${login}`)
      await server.end()
    },
  }
  return iso
}

export function useClock(start?: Date | string): FixedClock {
  const c = new FixedClock(start)
  setClock(c)
  return c
}

/* ---- the same tiny HTTP helpers as the shared harness, against the isolated database ---- */
type Handler = (req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>
export interface Reply { status: number; body: any; cookies: string[] }

export async function call(h: Handler, o: { method?: string; path?: string; body?: unknown; cookie?: string; params?: Record<string, string> } = {}): Promise<Reply> {
  const method = o.method ?? (o.body === undefined ? 'GET' : 'POST')
  const headers = new Headers({ host: 'localhost:3000', origin: 'http://localhost:3000' })
  if (o.body !== undefined) headers.set('content-type', 'application/json')
  if (o.cookie) headers.set('cookie', o.cookie)
  const res = await h(new Request(`http://localhost:3000${o.path ?? '/api/test'}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: o.params })
  return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() }
}

export async function signIn(u: { username: string; password: string }): Promise<string> {
  const { POST } = await import('../../../app/api/v1/auth/login/route')
  const r = await call(POST, { body: { username: u.username, password: u.password } })
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`)
  return r.cookies[0].split(';')[0]
}

const mods = import.meta.glob('../../../app/api/v1/access/**/route.ts', { eager: true }) as Record<string, Record<string, Handler>>
export function acc(cookie?: string) {
  const go = (method: string, path: string, o: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {}) => {
    const h = mods[`../../../app/api/v1/access/${path}/route.ts`]?.[method]
    if (!h) throw new Error(`no ${method} handler at ${path}`)
    const url = '/api/v1/access/' + path.replace(/\[(\w+)\]/g, (_m, k: string) => o.params?.[k] ?? randomUUID()) + (o.query ? '?' + new URLSearchParams(o.query).toString() : '')
    return call(h, { method, path: url, body: method === 'GET' ? undefined : (o.body ?? {}), cookie, params: o.params })
  }
  return { get: (p: string, o?: Parameters<typeof go>[2]) => go('GET', p, o), post: (p: string, o?: Parameters<typeof go>[2]) => go('POST', p, o), put: (p: string, o?: Parameters<typeof go>[2]) => go('PUT', p, o) }
}
