/// <reference types="vite/client" />
/**
 * Permission contract (STAGE-1 section 5). Generated from the code, not written by hand:
 *  - every route file exports handlers made by route(), so every route declares who may call it,
 *  - every policy action a route names exists in POLICY,
 *  - for every route that names a policy action and every role: if the policy says no, the real API answers 403
 *    before touching the body; if the policy says yes, it never answers 401/403 (it may say 422/404/200).
 * A route added without declaring access, or one whose guard drifts from POLICY, fails the build.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { call, closeAll, makeUser, newSite, signIn } from './harness'
import { ROLES, type Role } from '@/domain/enums'
import { ALL_ACTIONS, decide, type Action } from '@/server/policy'
import { buildActor } from '@/server/auth/actor'
import { route, REGISTERED_ROUTES, type RouteMeta } from '@/server/http'

const modules = import.meta.glob('../../app/api/**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>
const HTTP = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type H = ((req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>) & { meta?: RouteMeta }

interface Found { file: string; method: string; handler: H; path: string; params: Record<string, string> }
const found: Found[] = []
for (const [file, mod] of Object.entries(modules)) {
  const rel = file.replace('../../app', '').replace('/route.ts', '')
  const params: Record<string, string> = {}
  const path = rel.replace(/\[([^\]]+)\]/g, (_m, name: string) => (params[name] = crypto.randomUUID()))
  for (const m of HTTP) if (mod[m]) found.push({ file, method: m, handler: mod[m] as H, path, params })
}
// /api/health is infrastructure: public by design, exempt from route().
const governed = found.filter(f => !f.file.endsWith('/health/route.ts'))

afterAll(closeAll)

describe('route declarations', () => {
  it('finds the API routes', () => { expect(governed.length).toBeGreaterThan(0) })

  it.each(governed.map(f => [`${f.method} ${f.path}`, f] as const))('%s is built with route() and declares its access', (_n, f) => {
    expect(f.handler.meta, `${f.file} must export route({...}) handlers`).toBeDefined()
    expect(f.handler.meta!.method).toBe(f.method)
  })

  it('every named policy action exists', () => {
    for (const r of REGISTERED_ROUTES) if (r.access.kind === 'action') expect(ALL_ACTIONS, r.name).toContain(r.access.action)
  })

  it('route names are unique', () => {
    const names = REGISTERED_ROUTES.map(r => r.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('role x action, through the real API', () => {
  const cookies = new Map<Role, string>()
  const actors = new Map<Role, ReturnType<typeof buildActor>>()
  beforeAll(async () => {
    const siteId = await newSite()
    for (const role of ROLES) {
      const u = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role, siteId }] })
      cookies.set(role, await signIn(u))
      actors.set(role, buildActor({ assignments: [{ id: 'x', role, scopeKind: role === 'SA' ? 'all' : role === 'Res' ? 'own' : 'site', siteId: role === 'SA' || role === 'Res' ? null : siteId, buildingId: null }], caps: [] }, role, u.staffId))
    }
  })

  const actionRoutes = governed.filter(f => f.handler.meta?.access.kind === 'action')
  if (actionRoutes.length === 0) it('no policy-guarded routes yet (the work packages add them; this suite then covers each automatically)', () => {})
  else it.each(actionRoutes.map(f => [`${f.method} ${f.path}`, f] as const))('%s', async (_n, f) => {
    const action = (f.handler.meta!.access as { kind: 'action'; action: Action }).action
    const anon = await call(f.handler, { method: f.method, path: f.path, params: f.params })
    expect(anon.status, 'no session').toBe(401)
    for (const role of ROLES) {
      const allowed = decide(actors.get(role)!, action).allowed
      const r = await call(f.handler, { method: f.method, path: f.path, params: f.params, cookie: cookies.get(role), body: f.method === 'GET' ? undefined : {} })
      if (allowed) expect([401, 403].includes(r.status), `${role} should pass the guard for ${action}, got ${r.status}`).toBe(false)
      else expect(r.status, `${role} must be refused ${action}`).toBe(403)
    }
  })
})

describe('the guard itself (self-test with a throwaway route)', () => {
  it('refuses roles the policy refuses before reading the body, and lets the others through', async () => {
    const h = route({ name: 'selftest.rooms_manage', method: 'POST', access: { kind: 'action', action: 'rooms_beds.manage' }, body: z.object({ n: z.number() }), handler: async () => ({ ok: true as const, data: 1 }) })
    const siteId = await newSite()
    for (const role of ROLES) {
      const u = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role, siteId }] })
      const cookie = await signIn(u)
      const r = await call(h, { method: 'POST', body: { n: 'not a number' }, cookie })
      const mayManage = role === 'SA' || role === 'AA'
      expect(r.status, role).toBe(mayManage ? 422 : 403)
    }
  })
})
