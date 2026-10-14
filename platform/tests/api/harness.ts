/**
 * HTTP-level test harness: calls the real route handlers with real Request objects against a real PostgreSQL,
 * connected AS app_role (so a missing GRANT or a forbidden DELETE fails the test, exactly as in production).
 * Import this file FIRST in a test file: it points DATABASE_URL at the app login before the pool is created.
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { inject } from 'vitest'
import { hashPassword } from '@/server/auth/password'
import { FixedClock } from '@/server/clock'
import { resetClock, setClock } from '@/server/runtime'
import type { Capability, Role } from '@/domain/enums'

process.env.DATABASE_URL = inject('appDbUrl')

/** Superuser pool for arranging test data (the app role may not do everything a test needs to set up). */
let adminPool: Pool | undefined
export const admin = () => (adminPool ??= new Pool({ connectionString: inject('dbUrl'), max: 4 }))

export const uniq = (p = 'x') => `${p}-${randomUUID().slice(0, 8)}`
export const PASSWORD = 'Correct-horse-9'

export async function closeAll() {
  await adminPool?.end()
  adminPool = undefined
  const { getPool } = await import('@/server/db/client')
  await getPool().end()
  resetClock()
}

export function useClock(start?: Date | string): FixedClock {
  const c = new FixedClock(start)
  setClock(c)
  return c
}

export async function newSite(name = 'Test site'): Promise<string> {
  const r = await admin().query<{ id: string }>(`INSERT INTO site (code, name, kind) VALUES ($1, $2, 'villa') RETURNING id`, [uniq('S'), name])
  return r.rows[0].id
}

export interface TestUser { id: string; username: string; staffId: string; password: string }
export interface RoleSpec { role: Role; siteId?: string; all?: boolean }

export async function makeUser(o: { roles?: RoleSpec[]; username?: string; password?: string; mustChange?: boolean; status?: string } = {}): Promise<TestUser> {
  const username = o.username ?? uniq('u')
  const password = o.password ?? PASSWORD
  const staff = await admin().query<{ id: string }>(`INSERT INTO staff_profile (employee_id, full_name) VALUES ($1, $2) RETURNING id`, [uniq('E'), `Person ${username}`])
  const u = await admin().query<{ id: string }>(
    `INSERT INTO user_account (staff_id, username, password_hash, must_change_password, status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [staff.rows[0].id, username, await hashPassword(password), o.mustChange ?? false, o.status ?? 'active'])
  for (const r of o.roles ?? []) {
    const kind = r.all ? 'all' : r.siteId ? 'site' : r.role === 'Res' ? 'own' : 'job'
    await admin().query(`INSERT INTO role_assignment (user_id, role, scope_kind, site_id) VALUES ($1, $2, $3, $4)`, [u.rows[0].id, r.role, kind, r.siteId ?? null])
  }
  return { id: u.rows[0].id, username, staffId: staff.rows[0].id, password }
}

/** An active capability grant, made by one super admin and checked by another (so the table's own constraints hold). */
export async function grantCapability(userId: string, capability: Capability, o: { startsAt?: Date; expiresAt?: Date | null } = {}) {
  const maker = await makeUser({ roles: [{ role: 'SA', all: true }] })
  const checker = await makeUser({ roles: [{ role: 'SA', all: true }] })
  await admin().query(
    `INSERT INTO capability_grant (user_id, capability, reason, starts_at, expires_at, status, maker_id, checker_id, decided_at)
     VALUES ($1, $2, 'test', $3, $4, 'active', $5, $6, now())`,
    [userId, capability, o.startsAt ?? new Date((o.expiresAt?.getTime() ?? Date.now()) - 86_400_000), o.expiresAt ?? null, maker.id, checker.id])
}

type Handler = (req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>
export interface Reply<T = any> { status: number; body: T; cookies: string[]; headers: Headers }

export async function call(h: Handler, o: { method?: string; path?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; params?: Record<string, string> } = {}): Promise<Reply> {
  const method = o.method ?? (o.body === undefined ? 'GET' : 'POST')
  const headers = new Headers({ host: 'localhost:3000', origin: 'http://localhost:3000', ...o.headers })
  if (o.body !== undefined) headers.set('content-type', 'application/json')
  if (o.cookie) headers.set('cookie', o.cookie)
  const res = await h(new Request(`http://localhost:3000${o.path ?? '/api/test'}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: o.params })
  return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie(), headers: res.headers }
}

export const cookieValue = (setCookie: string) => setCookie.split(';')[0]

/** Signs in through the real login route; returns the cookie to send back. */
export async function signIn(u: Pick<TestUser, 'username' | 'password'>, headers: Record<string, string> = {}): Promise<string> {
  const { POST } = await import('../../app/api/v1/auth/login/route')
  const r = await call(POST, { body: { username: u.username, password: u.password }, headers })
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`)
  return cookieValue(r.cookies[0])
}
