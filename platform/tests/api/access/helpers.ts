/// <reference types="vite/client" />
/**
 * Helpers for the WP-C API tests. Import this (or ../harness) FIRST in a test file: the harness points DATABASE_URL at
 * the application login before the connection pool exists.
 */
import { randomUUID } from 'node:crypto'
import { admin, call, cookieValue, makeUser, newSite, PASSWORD, signIn, uniq, type Reply, type TestUser } from '../harness'

export { admin, call, cookieValue, makeUser, newSite, PASSWORD, signIn, uniq }
export type { Reply, TestUser }
export { closeAll, grantCapability, useClock } from '../harness'

type H = (req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>
const mods = import.meta.glob('../../../app/api/v1/access/**/route.ts', { eager: true }) as Record<string, Record<string, H>>

/** The route handler for `users/[id]/reset-password` and a method. */
export function handler(path: string, method: string): H {
  const mod = mods[`../../../app/api/v1/access/${path}/route.ts`]
  const h = mod?.[method]
  if (!h) throw new Error(`no ${method} handler at app/api/v1/access/${path}`)
  return h
}

export interface CallOpts { params?: Record<string, string>; body?: unknown; query?: Record<string, string> }

/**
 * D-03 / P-02: these routes re-ask for the signed-in person's password (default ON). The tests' people all use PASSWORD, so the client types it
 * for them unless a test passes its own `confirmPassword` (to prove a wrong or missing one is refused).
 */
const REAUTH_PATHS = new Set(['users/[id]/role-changes', 'role-changes/[id]/decide', 'grants', 'grants/[id]/decide', 'grants/[id]/revoke'])
export function withPassword(method: string, path: string, body: unknown): unknown {
  if (method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body) || 'confirmPassword' in body) return body
  const needs = REAUTH_PATHS.has(path) || (path === 'users' && !!(body as { initialRole?: unknown }).initialRole)
  return needs ? { ...body, confirmPassword: PASSWORD } : body
}

/** A thin client over the WP-C routes for one signed-in cookie (or none). */
export function acc(cookie?: string) {
  const go = (method: string, path: string, o: CallOpts = {}) => {
    const url = '/api/v1/access/' + path.replace(/\[(\w+)\]/g, (_m, k: string) => o.params?.[k] ?? randomUUID()) + (o.query ? '?' + new URLSearchParams(o.query).toString() : '')
    return call(handler(path, method), { method, path: url, body: method === 'GET' ? undefined : withPassword(method, path, o.body ?? {}), cookie, params: o.params })
  }
  return {
    get: (path: string, o?: CallOpts) => go('GET', path, o),
    post: (path: string, o?: CallOpts) => go('POST', path, o),
    put: (path: string, o?: CallOpts) => go('PUT', path, o),
  }
}

/** A staff profile that has no login account yet. */
export async function newStaff(o: { employeeId?: string; name?: string; status?: 'active' | 'left' } = {}): Promise<{ id: string; employeeId: string; name: string }> {
  const employeeId = o.employeeId ?? uniq('E')
  const name = o.name ?? `Staff ${employeeId}`
  const status = o.status ?? 'active'
  const r = await admin().query<{ id: string }>(
    `INSERT INTO staff_profile (employee_id, full_name, employment_status, left_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [employeeId, name, status, status === 'left' ? new Date() : null])
  return { id: r.rows[0].id, employeeId, name }
}

export interface Signed { user: TestUser; cookie: string; api: ReturnType<typeof acc> }
/** A user with the given roles, signed in. */
export async function signedIn(roles: Parameters<typeof makeUser>[0] = {}): Promise<Signed> {
  const user = await makeUser(roles)
  const cookie = await signIn(user)
  return { user, cookie, api: acc(cookie) }
}
export const superAdmin = () => signedIn({ roles: [{ role: 'SA', all: true }] })
export const accommodationAdmin = (siteId: string) => signedIn({ roles: [{ role: 'AA', siteId }] })

/** Every text column of every row of the given tables, as one string: used to prove a secret is nowhere. */
export async function dump(tables: string[]): Promise<string> {
  const parts: string[] = []
  for (const t of tables) parts.push((await admin().query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM ${t} x`)).rows.map(r => r.j).join('\n'))
  return parts.join('\n')
}

export const accountOf = async (userId: string) =>
  (await admin().query(`SELECT * FROM user_account WHERE id = $1`, [userId])).rows[0] as {
    id: string; username: string; password_hash: string; must_change_password: boolean; status: string; revoked_at: Date | null; last_login_at: Date | null
  }
export const activeRoles = async (userId: string) =>
  (await admin().query<{ role: string; scope_kind: string; site_id: string | null }>(
    `SELECT role, scope_kind, site_id FROM role_assignment WHERE user_id = $1 AND revoked_at IS NULL ORDER BY role`, [userId])).rows
