/// <reference types="vite/client" />
/**
 * Permission contract, existence edition (AT-002 / AT-038 family). The generator is the one of tests/api/contract.test.ts: every route file under
 * app/api that names a policy action, every role, a real session. For each route and each role the API must not tell anybody whether a record
 * exists unless they may see it:
 *   - a role that lacks the action is refused with 403 whether or not the record exists (the answers are identical);
 *   - a role that HOLDS the action but at another site (or for another person) gets the same answer for a record that exists as for one
 *     that does not (404 "not found" or the same validation answer), never 200 and never a "forbidden" that proves the record is there.
 * The routes that take an id are called with a REAL record of a site the probe people have no part in, and with a random id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, closeAll, makeUser, signIn } from '../harness'
import { ROLES, type Role } from '@/domain/enums'
import { decide, type Action } from '@/server/policy'
import { buildActor } from '@/server/auth/actor'
import type { RouteMeta } from '@/server/http'
import * as RQ from '../requests/helpers'
import * as ST from '../stays/helpers'
import * as EM from '../emergency/helpers'
import * as XT from '../exit/helpers'
import * as KY from '../keys/helpers'
import * as RD from '../readiness/helpers'
import * as WL from '../waitlist/helpers'
import { approveRequest } from '@/server/commands/requests/approve'
import { requestTransfer } from '@/server/commands/stays/requestTransfer'
import { requestExtension } from '@/server/commands/stays/extension'
import { requestCheckout } from '@/server/commands/stays/checkout'
import { rejectEmergency } from '@/server/commands/emergency/decide'
import { markLeft } from '@/server/commands/exit/markLeft'
import { previewBulkExit } from '@/server/commands/exit/bulk'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { createOffer } from '@/server/commands/waitlist/offer'
import { previewBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { requestRoleChange } from '@/server/commands/access/request-role-change'
import { requestGrant } from '@/server/commands/access/request-grant'
import { rcFor } from '../rc'

afterAll(closeAll)

const modules = import.meta.glob('../../../app/api/**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>
const HTTP = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type H = ((req: Request, ctx?: { params?: Record<string, string> }) => Promise<Response>) & { meta?: RouteMeta }
interface Found { file: string; rel: string; method: string; handler: H; paramNames: string[] }
const found: Found[] = []
for (const [file, mod] of Object.entries(modules)) {
  if (file.endsWith('/health/route.ts')) continue
  const rel = file.replace('../../../app/api/v1/', '').replace('/route.ts', '')
  const paramNames = [...rel.matchAll(/\[([^\]]+)\]/g)].map(m => m[1])
  for (const m of HTTP) if (mod[m]) found.push({ file, rel, method: m, handler: mod[m] as H, paramNames })
}
const actionRoutes = found.filter(f => f.handler.meta?.access.kind === 'action')

const uuid = () => crypto.randomUUID()
const pathOf = (rel: string, params: Record<string, string>) => '/api/v1/' + rel.replace(/\[([^\]]+)\]/g, (_m, n: string) => params[n])
/** Everything the person on the other end can learn from an answer, without the per-request id. */
const shape = (r: { status: number; body: any }) => ({ status: r.status, code: r.body?.code, reason: r.body?.reason, fields: r.body?.fields })

/* ---------------- the probe people: every role, at a site that owns none of the records ---------------- */

const cookies = new Map<Role, string>()
const actors = new Map<Role, ReturnType<typeof buildActor>>()
beforeAll(async () => {
  const away = await RQ.mkProperty({ beds: 1 })
  for (const role of ROLES) {
    const u = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role, siteId: away.siteId }] })
    cookies.set(role, await signIn(u))
    actors.set(role, buildActor({ assignments: [{ id: 'x', role, scopeKind: role === 'SA' ? 'all' : role === 'Res' ? 'own' : 'site', siteId: role === 'SA' || role === 'Res' ? null : away.siteId, buildingId: null }], caps: [] }, role, u.staffId))
  }
})

/* ---------------- the records, per family of routes ---------------- */

type Bodies = Record<string, unknown>
interface Family { ids: Record<string, string>; bodies?: Bodies }
const FAMILIES: { name: string; match: RegExp; make: () => Promise<Family> }[] = [
  { name: 'request', match: /^requests\/\[id\]/, make: async () => {
    const s = await RQ.scenario({ beds: 2 })
    return { ids: { id: s.requestId }, bodies: { approve: { bedId: s.bedIds[0] }, reject: { reason: 'No capacity' }, changes: { reason: 'Give an end date' }, cancel: { reason: 'Not needed' }, 'exception/request': { reason: 'Needs this room', kinds: ['gender'] }, 'exception/grant': { kinds: ['gender'], reason: 'ok', evidence: 'memo' }, 'exception/decline': { reason: 'no' }, edit: { note: 'x' } } }
  } },
  { name: 'reservation', match: /^requests\/reservations\/\[id\]/, make: async () => {
    const s = await RQ.scenario({ beds: 2 })
    const other = await RQ.who('AA', { siteIds: [s.siteId] })
    const r = await approveRequest(other.rc, { requestId: s.requestId, bedId: s.bedIds[0] })
    if (!r.ok) throw new Error(r.reason)
    return { ids: { id: r.data.reservationId }, bodies: { cancel: { reason: 'No longer needed' }, 'extend-no-show': { reason: 'Flight delayed' } } }
  } },
  { name: 'bulk allocation', match: /^requests\/bulk\/\[id\]/, make: async () => {
    const s = await RQ.scenario({ beds: 2 })
    const p = await previewBulkAllocation(s.aa.rc, { siteId: s.siteId, requestIds: [s.requestId] })
    if (!p.ok) throw new Error(p.reason)
    return { ids: { id: p.data.batchId } }
  } },
  { name: 'stay', match: /^stays\/\[id\]/, make: async () => {
    const w = await ST.world({ beds: 3 })
    const [res] = await ST.residents(1)
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(-5), to: ST.day(30) })
    return { ids: { id: s.stayId }, bodies: { checkout: { note: null }, 'checkout-request': { departureDate: ST.day(5), note: null }, extension: { newEnd: ST.day(45), reason: 'x' }, transfer: { reason: 'Noisy room', destinationBedId: w.bedIds[1] } } }
  } },
  { name: 'transfer', match: /^stays\/transfers\/\[id\]/, make: async () => {
    const w = await ST.world({ beds: 3 })
    const [res] = await ST.residents(1)
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(-5), to: ST.day(30) })
    const t = await requestTransfer(res.rc, { stayId: s.stayId, destinationBedId: w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
    if (!t.ok) throw new Error(t.reason)
    return { ids: { id: t.data.id }, bodies: { approve: {}, reject: { reason: 'Not now' }, execute: {}, consent: { party: 'a', via: 'in_person' } } }
  } },
  { name: 'extension', match: /^stays\/extensions\/\[id\]/, make: async () => {
    const w = await ST.world({ beds: 2 })
    const [res] = await ST.residents(1)
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(-5), to: ST.day(30) })
    const e = await requestExtension(res.rc, { stayId: s.stayId, newEnd: ST.day(45), reason: 'Project runs on' })
    if (!e.ok) throw new Error(e.reason)
    return { ids: { id: e.data.id }, bodies: { approve: {}, reject: { reason: 'Not now' } } }
  } },
  { name: 'checkout request', match: /^stays\/checkout-requests\/\[id\]/, make: async () => {
    const w = await ST.world({ beds: 2 })
    const [res] = await ST.residents(1)
    const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(-5), to: ST.day(30) })
    const c = await requestCheckout(res.rc, { stayId: s.stayId, departureDate: ST.day(5), note: null })
    if (!c.ok) throw new Error(c.reason)
    return { ids: { id: c.data.id } }
  } },
  { name: 'emergency case', match: /^emergency\/\[id\]/, make: async () => {
    const w = await EM.world()
    const e = await EM.start(w, { by: w.rec })
    return { ids: { id: e.caseId }, bodies: { approve: {}, reject: { reason: 'Not an emergency' } } }
  } },
  { name: 'emergency task', match: /^emergency\/tasks\/\[id\]/, make: async () => {
    const w = await EM.world()
    const e = await EM.start(w, { by: w.rec })
    const rej = await rejectEmergency(w.aa.rc(EM.clockAt(2)), { caseId: e.caseId, reason: 'Not an emergency' })
    if (!rej.ok) throw new Error(rej.reason)
    return { ids: { id: rej.data.task!.id }, bodies: { complete: { note: 'Relocated to block C' } } }
  } },
  { name: 'bulk Mark as Left preview', match: /^exit\/bulk\/\[id\]/, make: async () => {
    const w = await XT.world()
    const r = await XT.resident({ bedId: w.bedIds[0] })
    const p = await previewBulkExit(w.aa.rc(), { employeeIds: [r.employeeId], effectiveDate: '2026-10-14', reason: 'Restructure' } as never)
    if (!p.ok) throw new Error(p.reason)
    return { ids: { id: p.data.batchId } }
  } },
  { name: 'clearance case', match: /^exit\/(\[id\]|items)/, make: async () => {
    const w = await XT.world()
    const r = await XT.resident({ bedId: w.bedIds[0] })
    const left = await markLeft(w.aa.rc(), { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: XT.PASSWORD })
    if (!left.ok) throw new Error(left.reason)
    const item = (await XT.itemsOf(left.data.caseId))[0].id
    return { ids: { id: item, caseId: left.data.caseId }, bodies: { complete: { note: 'done' }, outstanding: { note: 'not yet' }, reopen: { reason: 'mistake' }, waive: { reason: 'Write it off', evidence: 'memo', confirmPassword: XT.PASSWORD } } }
  } },
  { name: 'key', match: /^keys\/\[id\]/, make: async () => {
    const w = await KY.world({ beds: 2 })
    const res = await KY.resident(w.bedIds[0])
    const id = await KY.mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
    return { ids: { id }, bodies: { issue: { staffId: res.staffId, dueBack: null, note: null }, lost: { note: 'Reported at the desk' }, damaged: { note: 'Reported at the desk' }, found: { to: 'cabinet', note: null }, retire: { reason: 'Written off' }, archive: { reason: 'Lock changed' }, replace: { newCode: 'K-' + uuid().slice(0, 6) } } }
  } },
  { name: 'cleaning task', match: /^readiness\/tasks\/\[id\]/, make: async () => {
    const s = await RD.scene({ beds: 2 })
    const v = await RD.vacate(s, s.bedIds[0])
    return { ids: { id: v.taskId }, bodies: { assign: { housekeeperStaffId: s.hk.staffId }, cancel: { reason: 'Not needed' }, clean: { checklist: RD.FULL, notes: null }, pass: {}, fail: { note: 'Not clean enough' } } }
  } },
  { name: 'bed', match: /^property\/beds\/\[id\]/, make: async () => { const p = await RQ.mkProperty({ beds: 1 }); return { ids: { id: p.bedIds[0] }, bodies: { block: { reason: 'Ceiling repair' }, unblock: {}, archive: { reason: 'Removed' } } } } },
  { name: 'room', match: /^property\/rooms\/\[id\]/, make: async () => { const p = await RQ.mkProperty({ beds: 0 }); return { ids: { id: p.roomId }, bodies: { archive: { reason: 'Converted' } } } } },
  { name: 'building', match: /^property\/buildings\/\[id\]/, make: async () => { const p = await RQ.mkProperty({ beds: 0 }); return { ids: { id: p.buildingId! }, bodies: { archive: { reason: 'Demolished' } } } } },
  { name: 'site', match: /^property\/sites\/\[id\]/, make: async () => { const p = await RQ.mkProperty({ beds: 0 }); return { ids: { id: p.siteId } } } },
  { name: 'waitlist entry', match: /^waitlist\/\[id\]/, make: async () => {
    const w = await WL.world({ beds: 2 })
    const win = WL.window()
    const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
    if (!e.ok) throw new Error(e.reason)
    return { ids: { id: e.data.entryId }, bodies: { offer: { bedId: w.bedIds[0] }, leave: { reason: 'Found housing' }, renew: {}, priority: { category: 'Medical', reason: 'ground floor', evidence: 'letter' } } }
  } },
  { name: 'bed offer', match: /^waitlist\/offers\/\[id\]/, make: async () => {
    const w = await WL.world({ beds: 2 })
    const win = WL.window()
    const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
    if (!e.ok) throw new Error(e.reason)
    const o = await createOffer(w.aa.rc(win.clock), { entryId: e.data.entryId, bedId: w.bedIds[0] })
    if (!o.ok) throw new Error(o.reason)
    return { ids: { id: o.data.offerId }, bodies: { 'accept-on-behalf': { consent: 'Said yes by phone' }, decline: {}, delivery: { via: 'offline', note: 'Told at the desk' }, withdraw: { reason: 'Bed needed' } } }
  } },
  { name: 'account', match: /^access\/users\/\[id\]/, make: async () => {
    const p = await RQ.mkProperty({ beds: 0 })
    const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
    return { ids: { id: target.id }, bodies: { deactivate: { reason: 'Left' }, reactivate: { reason: 'Back' }, 'reset-password': { reason: 'Forgot it' }, 'revoke-sessions': { reason: 'Lost phone' }, 'role-changes': { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: p.siteId, reason: 'x' } } }
  } },
  { name: 'role change', match: /^access\/role-changes\/\[id\]/, make: async () => {
    const p = await RQ.mkProperty({ beds: 0 })
    const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
    const maker = await makeUser({ roles: [{ role: 'SA', all: true }] })
    const r = await requestRoleChange(rcFor(maker.id, { role: 'SA', sites: 'all', staffId: maker.staffId }), { kind: 'add', userId: target.id, role: 'AA', scopeKind: 'site', siteId: p.siteId, reason: 'x' })
    if (!r.ok) throw new Error(r.reason)
    return { ids: { id: r.data.requestId }, bodies: { decide: { decision: 'reject', note: 'No' } } }
  } },
  { name: 'capability grant', match: /^access\/grants\/\[id\]/, make: async () => {
    const p = await RQ.mkProperty({ beds: 0 })
    const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
    const maker = await makeUser({ roles: [{ role: 'SA', all: true }] })
    const g = await requestGrant(rcFor(maker.id, { role: 'SA', sites: 'all', staffId: maker.staffId }), { userId: target.id, capability: 'NightKeys', reason: 'Night cover' })
    if (!g.ok) throw new Error(g.reason)
    return { ids: { id: g.data.grantId }, bodies: { decide: { decision: 'reject', note: 'No' }, revoke: { reason: 'No longer needed' } } }
  } },
]

const lastSegment = (rel: string) => rel.replace(/^.*\[id\]\/?/, '')

describe('permission contract: nobody learns whether a record exists unless they may see it', () => {
  it('finds the routes', () => { expect(actionRoutes.length).toBeGreaterThan(50) })

  it('the families cover the routes that take an id (the rest are listed here, not forgotten)', () => {
    const idRoutes = actionRoutes.filter(f => f.paramNames.includes('id'))
    const uncovered = idRoutes.filter(f => !FAMILIES.some(x => x.match.test(f.rel))).map(f => `${f.method} ${f.rel}`)
    // Staff profiles have their own scope tests (tests/api/staff); attachments, delegations and imports are not guarded by a policy action here.
    expect(uncovered.sort()).toEqual(['PATCH staff/[id]', 'POST staff/[id]/archive'])
  })

  describe('a role that lacks the action: 403 for a record that exists and for one that does not, with the same answer', () => {
    it.each(actionRoutes.map(f => [`${f.method} ${f.rel}`, f] as const))('%s', async (_n, f) => {
      const action = (f.handler.meta!.access as { kind: 'action'; action: Action }).action
      const ids = () => Object.fromEntries(f.paramNames.map(n => [n, uuid()]))
      for (const role of ROLES) {
        if (decide(actors.get(role)!, action).allowed) continue
        const a = await call(f.handler, { method: f.method, path: pathOf(f.rel, ids()), params: ids(), cookie: cookies.get(role), body: f.method === 'GET' ? undefined : {} })
        const p1 = ids(), p2 = ids()
        const b = await call(f.handler, { method: f.method, path: pathOf(f.rel, p1), params: p1, cookie: cookies.get(role), body: f.method === 'GET' ? undefined : {} })
        const c = await call(f.handler, { method: f.method, path: pathOf(f.rel, p2), params: p2, cookie: cookies.get(role), body: f.method === 'GET' ? undefined : {} })
        expect([a.status, b.status, c.status], `${role} lacks ${action}`).toEqual([403, 403, 403])
        expect(shape(b)).toEqual(shape(c))
        expect(shape(a)).toEqual(shape(b))
      }
    })
  })

  describe('a real record of a site the person has no part in answers exactly like a record that does not exist', () => {
    const covered = actionRoutes.filter(f => FAMILIES.some(x => x.match.test(f.rel)))
    it.each(covered.map(f => [`${f.method} ${f.rel}`, f] as const))('%s', async (_n, f) => {
      const fam = FAMILIES.find(x => x.match.test(f.rel))!
      const action = (f.handler.meta!.access as { kind: 'action'; action: Action }).action
      const rec = await fam.make()
      const body = f.method === 'GET' ? undefined : (rec.bodies?.[lastSegment(f.rel)] ?? rec.bodies?.[f.rel.replace(/^.*\[id\]\//, '')] ?? {})
      const real = { ...Object.fromEntries(f.paramNames.map(n => [n, uuid()])), ...rec.ids }
      for (const role of ROLES) {
        if (role === 'SA') continue // a Super Admin has every site: nothing is out of scope for them
        const missing = { ...real, id: uuid(), caseId: uuid() }
        const a = await call(f.handler, { method: f.method, path: pathOf(f.rel, real), params: real, cookie: cookies.get(role), body })
        const b = await call(f.handler, { method: f.method, path: pathOf(f.rel, missing), params: missing, cookie: cookies.get(role), body })
        const holds = decide(actors.get(role)!, action).allowed
        if (!holds) { expect([a.status, b.status], `${role} lacks ${action}`).toEqual([403, 403]); expect(shape(a)).toEqual(shape(b)); continue }
        expect(a.status, `${role} (holds ${action}, other site) must not be let in: ${JSON.stringify(a.body)}`).not.toBe(200)
        expect(shape(a), `${role}: the answer must be the same whether or not the record exists`).toEqual(shape(b))
      }
    })
  })
})
