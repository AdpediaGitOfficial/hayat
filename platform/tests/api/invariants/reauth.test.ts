/// <reference types="vite/client" />
/**
 * AT-034: password re-confirmation at the API (D-03, P-02). PROPOSED, pending client sign-off: `auth.reauth_actions` ships with the D-03
 * actions ON (emergency initiation, role changes, queue override) and the extra proposals OFF (emergency decisions, capability grants).
 *
 * For every action the real route is called with a real session: password missing, wrong, right, in both states of the list. A wrong or
 * missing password changes nothing and answers 422 with `fields.confirmPassword`; wrong attempts are counted and throttled like sign-in; the right
 * password goes through. The list is changed through the System configuration route, so the change is a new audited version.
 * Mark as Left, bulk exit, waiver and rehire enforce it in the command (Stage 3) and are covered by tests/api/exit.
 *
 * Runs against a private database because it changes a global setting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolated, useClock, call, type Reply } from '../access/isolated'
import { T0, invKit, day, type Cast } from './kit'
import { PASSWORD } from '../access/isolated'
import { FixedClock } from '@/server/clock'
import { reauthEnabled } from '@/server/auth/reauth'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { requestRoleChange } from '@/server/commands/access/request-role-change'
import { requestGrant } from '@/server/commands/access/request-grant'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { POST as initiateRoute } from '../../../app/api/v1/emergency/route'
import { POST as approveRoute } from '../../../app/api/v1/emergency/[id]/approve/route'
import { POST as rejectRoute } from '../../../app/api/v1/emergency/[id]/reject/route'
import { POST as roleRequestRoute } from '../../../app/api/v1/access/users/[id]/role-changes/route'
import { POST as roleDecideRoute } from '../../../app/api/v1/access/role-changes/[id]/decide/route'
import { POST as grantRequestRoute } from '../../../app/api/v1/access/grants/route'
import { POST as grantDecideRoute } from '../../../app/api/v1/access/grants/[id]/decide/route'
import { POST as grantRevokeRoute } from '../../../app/api/v1/access/grants/[id]/revoke/route'
import { POST as createUserRoute } from '../../../app/api/v1/access/users/route'
import { PUT as configRoute } from '../../../app/api/v1/access/config/[key]/route'
import { POST as offerRoute } from '../../../app/api/v1/waitlist/[id]/offer/route'

const iso = await createIsolated()
afterAll(() => iso.close())
const k = invKit(iso)
const q = k.q

type Action = 'emergency.initiate' | 'emergency.decide' | 'access.role_change' | 'access.grant' | 'waitlist.queue_override'
const ALL: Action[] = ['emergency.initiate', 'emergency.decide', 'access.role_change', 'access.grant', 'waitlist.queue_override']
const D03: Action[] = ['emergency.initiate', 'access.role_change', 'waitlist.queue_override']

let sa: Cast
let home: Awaited<ReturnType<typeof k.property>>
let clock: FixedClock

beforeAll(async () => {
  clock = new FixedClock(T0)
  useClock(T0)
  sa = await k.cast('SA')
  home = await k.property({ beds: 80 })
})

/** Sets the list through the real System configuration route (a new audited version) and returns the reply. */
async function setList(actions: Action[]): Promise<Reply> {
  const r = await call(configRoute, { method: 'PUT', body: { value: actions, reason: 'AT-034 test' }, cookie: await sa.cookie(), params: { key: 'auth.reauth_actions' } })
  if (r.status !== 200) throw new Error('config: ' + JSON.stringify(r.body))
  return r
}

let bedCursor = 0
const nextBed = () => { if (bedCursor >= home.bedIds.length) throw new Error('out of beds'); return home.bedIds[bedCursor++] }

/** One scenario = a fresh arrangement and the call. `changed()` says whether the action took effect. */
interface Run { reply: (pw: string | undefined | null) => Promise<Reply>; changed: () => Promise<boolean>; actor: Cast }
type Scenario = () => Promise<Run>

const SCENARIOS: Record<string, { action: Action; make: Scenario }> = {
  'emergency initiation': {
    action: 'emergency.initiate',
    make: async () => {
      const rec = await k.cast('Rec', { siteId: home.siteId, caps: ['EmergencyCheckin'] })
      const person = await k.staff()
      const bedId = nextBed()
      return {
        actor: rec,
        reply: async pw => call(initiateRoute, { body: { staffId: person.id, bedId, reason: 'Flood in block B', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await rec.cookie() }),
        changed: async () => (await q(`SELECT 1 FROM emergency_checkin WHERE staff_id = $1`, [person.id])).length > 0,
      }
    },
  },
  'emergency approval': {
    action: 'emergency.decide',
    make: async () => {
      const rec = await k.cast('Rec', { siteId: home.siteId, caps: ['EmergencyCheckin'] })
      const aa = await k.cast('AA', { siteId: home.siteId })
      const person = await k.staff()
      const r = await initiateEmergency(rec.rc(clock), { staffId: person.id, bedId: nextBed(), reason: 'Flood in block C' })
      if (!r.ok) throw new Error(r.reason)
      const id = r.data.caseId
      return {
        actor: aa,
        reply: async pw => call(approveRoute, { body: { note: 'Accepted', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await aa.cookie(), params: { id } }),
        changed: async () => (await q<{ status: string }>(`SELECT status FROM emergency_checkin WHERE id = $1`, [id]))[0].status !== 'pending',
      }
    },
  },
  'emergency rejection': {
    action: 'emergency.decide',
    make: async () => {
      const rec = await k.cast('Rec', { siteId: home.siteId, caps: ['EmergencyCheckin'] })
      const aa = await k.cast('AA', { siteId: home.siteId })
      const person = await k.staff()
      const r = await initiateEmergency(rec.rc(clock), { staffId: person.id, bedId: nextBed(), reason: 'Flood in block D' })
      if (!r.ok) throw new Error(r.reason)
      const id = r.data.caseId
      return {
        actor: aa,
        reply: async pw => call(rejectRoute, { body: { reason: 'Not an emergency', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await aa.cookie(), params: { id } }),
        changed: async () => (await q<{ status: string }>(`SELECT status FROM emergency_checkin WHERE id = $1`, [id]))[0].status !== 'pending',
      }
    },
  },
  'role-change request': {
    action: 'access.role_change',
    make: async () => {
      const maker = await k.cast('SA')
      const target = await k.cast('Res')
      return {
        actor: maker,
        reply: async pw => call(roleRequestRoute, { body: { kind: 'add', role: 'Rec', scopeKind: 'site', siteId: home.siteId, reason: 'New desk officer', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await maker.cookie(), params: { id: target.userId } }),
        changed: async () => (await q(`SELECT 1 FROM role_change_request WHERE target_user_id = $1`, [target.userId])).length > 0,
      }
    },
  },
  'role-change request filed with a new account': {
    action: 'access.role_change',
    make: async () => {
      const maker = await k.cast('SA')
      const person = await k.staff()
      return {
        actor: maker,
        reply: async pw => call(createUserRoute, { body: { employeeId: person.employeeId, reason: 'New desk officer', siteId: home.siteId, initialRole: { role: 'Rec', scopeKind: 'site', siteId: home.siteId }, ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await maker.cookie() }),
        changed: async () => (await q(`SELECT 1 FROM user_account WHERE staff_id = $1`, [person.id])).length > 0,
      }
    },
  },
  'role-change decision': {
    action: 'access.role_change',
    make: async () => {
      const target = await k.cast('Res'), checker = await k.cast('SA')
      const r = await requestRoleChange(sa.rc(clock), { kind: 'add', userId: target.userId, role: 'Rec', scopeKind: 'site', siteId: home.siteId, reason: 'New desk officer' })
      if (!r.ok) throw new Error(r.reason)
      const id = r.data.requestId
      return {
        actor: checker,
        reply: async pw => call(roleDecideRoute, { body: { decision: 'reject', note: 'Not needed', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await checker.cookie(), params: { id } }),
        changed: async () => (await q<{ status: string }>(`SELECT status FROM role_change_request WHERE id = $1`, [id]))[0].status !== 'pending',
      }
    },
  },
  'capability grant request': {
    action: 'access.grant',
    make: async () => {
      const maker = await k.cast('SA')
      const target = await k.cast('Rec', { siteId: home.siteId })
      return {
        actor: maker,
        reply: async pw => call(grantRequestRoute, { body: { userId: target.userId, capability: 'NightKeys', reason: 'Night shift cover', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await maker.cookie() }),
        changed: async () => (await q(`SELECT 1 FROM capability_grant WHERE user_id = $1`, [target.userId])).length > 0,
      }
    },
  },
  'capability grant decision': {
    action: 'access.grant',
    make: async () => {
      const target = await k.cast('Rec', { siteId: home.siteId }), checker = await k.cast('SA')
      const r = await requestGrant(sa.rc(clock), { userId: target.userId, capability: 'NightKeys', reason: 'Night shift cover' })
      if (!r.ok) throw new Error(r.reason)
      const id = r.data.grantId
      return {
        actor: checker,
        reply: async pw => call(grantDecideRoute, { body: { decision: 'approve', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await checker.cookie(), params: { id } }),
        changed: async () => (await q<{ status: string }>(`SELECT status FROM capability_grant WHERE id = $1`, [id]))[0].status !== 'pending',
      }
    },
  },
  'capability grant revoke': {
    action: 'access.grant',
    make: async () => {
      const maker = await k.cast('SA')
      const target = await k.cast('Rec', { siteId: home.siteId, caps: ['NightKeys'] })
      const id = (await q<{ id: string }>(`SELECT id FROM capability_grant WHERE user_id = $1`, [target.userId]))[0].id
      return {
        actor: maker,
        reply: async pw => call(grantRevokeRoute, { body: { reason: 'No longer on nights', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await maker.cookie(), params: { id } }),
        changed: async () => (await q<{ status: string }>(`SELECT status FROM capability_grant WHERE id = $1`, [id]))[0].status === 'revoked',
      }
    },
  },
  'queue override': {
    action: 'waitlist.queue_override',
    make: async () => {
      const prop = await k.property({ beds: 1 })
      const aa = await k.cast('AA', { siteId: prop.siteId })
      const [a, b] = [await k.cast('Res'), await k.cast('Res')]
      const first = await addToWaitlist(aa.rc(new FixedClock(T0.getTime())), { staffId: a.staffId, siteId: prop.siteId, arrival: day(5) })
      const second = await addToWaitlist(aa.rc(new FixedClock(T0.getTime() + 3_600_000)), { staffId: b.staffId, siteId: prop.siteId, arrival: day(5) })
      if (!first.ok || !second.ok) throw new Error('waitlist setup')
      return {
        actor: aa,
        // the second person in the queue is offered the bed: someone is ahead, so this IS a queue override
        reply: async pw => call(offerRoute, { body: { bedId: prop.bedIds[0], overrideReason: 'Needs the ground floor', ...(pw === null ? {} : { confirmPassword: pw }) }, cookie: await aa.cookie(), params: { id: second.data.entryId } }),
        changed: async () => (await q(`SELECT 1 FROM bed_offer WHERE waitlist_entry_id = $1`, [second.data.entryId])).length > 0,
      }
    },
  },
}

const wrongAttempts = async (userId: string) => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM login_attempt WHERE username_norm = $1`, ['reauth:' + userId]))[0].n

describe('AT-034 defaults (D-03, P-02 proposed, pending client sign-off)', () => {
  it('ships with the D-03 actions ON and the extra proposals OFF', async () => {
    for (const a of ALL) expect(await reauthEnabled(a), a).toBe(D03.includes(a))
  })
})

describe('AT-034 the action is listed: password missing, wrong, right', () => {
  beforeAll(async () => { await setList(ALL) })

  for (const [name, { make }] of Object.entries(SCENARIOS)) {
    it(`${name}: missing password and wrong password change nothing (422, field error); the right one proceeds`, async () => {
      const run = await make()
      const missing = await run.reply(null)
      expect(missing.status).toBe(422)
      expect(missing.body.fields?.confirmPassword).toBe('Required')
      expect(await run.changed()).toBe(false)

      const before = await wrongAttempts(run.actor.userId)
      const wrong = await run.reply('Not-my-password-1')
      expect(wrong.status).toBe(422)
      expect(wrong.body.fields?.confirmPassword).toBe('Wrong password')
      expect(await run.changed()).toBe(false)
      expect(await wrongAttempts(run.actor.userId), 'the wrong attempt is counted').toBe(before + 1)

      const right = await run.reply(PASSWORD)
      expect(right.status, JSON.stringify(right.body)).toBe(200)
      expect(await run.changed()).toBe(true)
    })
  }

  it('wrong attempts are throttled like sign-in: after the limit even the right password is refused (429), and it works again once the window passes', async () => {
    const run = await SCENARIOS['emergency initiation'].make()
    for (let i = 0; i < 5; i++) expect((await run.reply('wrong-password-' + i)).status).toBe(422)
    const locked = await run.reply(PASSWORD)
    expect(locked.status).toBe(429)
    expect(locked.body.code).toBe('rate_limited')
    expect(await run.changed()).toBe(false)
    useClock(new Date(T0.getTime() + 16 * 60_000))
    const again = await run.reply(PASSWORD)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(await run.changed()).toBe(true)
    useClock(T0)
  })

  it('the password is stripped before the handler: it is never stored (audit rows, notifications)', async () => {
    const run = await SCENARIOS['role-change request'].make()
    const r = await run.reply(PASSWORD)
    expect(r.status).toBe(200)
    const dump = JSON.stringify((await q(`SELECT before, after, reason FROM audit_event ORDER BY seq DESC LIMIT 20`)))
    expect(dump).not.toContain(PASSWORD)
  })

  it('the queue override asks only when overrideReason is in the body: offering the bed to the person at the head of the queue needs no password', async () => {
    const prop = await k.property({ beds: 1 })
    const aa = await k.cast('AA', { siteId: prop.siteId })
    const a = await k.cast('Res')
    const e = await addToWaitlist(aa.rc(new FixedClock(T0.getTime())), { staffId: a.staffId, siteId: prop.siteId, arrival: day(5) })
    if (!e.ok) throw new Error('setup')
    const r = await call(offerRoute, { body: { bedId: prop.bedIds[0] }, cookie: await aa.cookie(), params: { id: e.data.entryId } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })
})

describe('AT-034 the action is not listed: the previous behaviour', () => {
  beforeAll(async () => { await setList([]) })

  for (const [name, { make }] of Object.entries(SCENARIOS)) {
    it(`${name}: no password needed; one that is sent is stripped, not checked`, async () => {
      const run = await make()
      const before = await wrongAttempts(run.actor.userId)
      const r = await run.reply('not-even-checked-1')
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      expect(await run.changed()).toBe(true)
      expect(await wrongAttempts(run.actor.userId)).toBe(before)
      const run2 = await make()
      expect((await run2.reply(null)).status).toBe(200)
      expect(await run2.changed()).toBe(true)
    })
  }
})

describe('AT-034 each action on its own: the list decides, per action', () => {
  it.each(ALL)('only %s listed: that action asks, the others do not', async only => {
    await setList([only])
    for (const [name, { action, make }] of Object.entries(SCENARIOS)) {
      const run = await make()
      const r = await run.reply(null)
      if (action === only) {
        expect(r.status, name).toBe(422)
        expect(r.body.fields?.confirmPassword, name).toBe('Required')
        expect(await run.changed(), name).toBe(false)
      } else {
        expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200)
      }
    }
  })
})

describe('AT-034 the list is configurable and audited', () => {
  it('every change of the list is a new configuration version with the actor, the reason and before/after', async () => {
    const r1 = await setList(['emergency.initiate'])
    const r2 = await setList(D03)
    expect(r2.body.data.version).toBe(r1.body.data.version + 1)
    const rows = await q<{ action: string; actor_user_id: string; reason: string; before: any; after: any }>(
      `SELECT action, actor_user_id, reason, before, after FROM audit_event WHERE action = 'config.changed' AND after->>'key' = 'auth.reauth_actions' ORDER BY seq DESC LIMIT 2`)
    expect(rows[0]).toMatchObject({ actor_user_id: sa.userId, reason: 'AT-034 test' })
    expect(rows[0].after.value).toEqual(D03)
    expect(rows[0].before.value).toEqual(['emergency.initiate'])
    // the registry flags it as proposed, not decided
    expect(rows[0].after.decisionStatus).toBe('open')
  })
})
