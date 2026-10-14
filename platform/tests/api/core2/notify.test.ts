import { afterAll, describe, expect, it } from 'vitest'
import { admin, call, closeAll, makeUser, newSite, signIn, uniq } from '../harness'
import { mkStaff, notificationsByKey } from '../fixtures2'
import { rcFor } from '../rc'
import { runCommand } from '@/server/command/run'
import { ok, fail } from '@/server/command/result'
import { notify, listNotifications, unreadCount } from '@/server/notify'
import { getDb } from '@/server/db/client'
import { GET as list } from '../../../app/api/v1/notifications/route'
import { POST as read } from '../../../app/api/v1/notifications/read/route'

afterAll(closeAll)
const sa = async () => { const u = await makeUser({ roles: [{ role: 'SA', all: true }] }); return rcFor(u.id, { role: 'SA', sites: 'all' }) }

describe('notify (AT-030: a retried event creates one notification)', () => {
  it('the same dedupe key notifies once, however often the event is retried', async () => {
    const s = await mkStaff()
    const key = uniq('evt')
    const rc = await sa()
    for (let i = 0; i < 3; i++) await runCommand(rc, async c => { await notify(c.tx, { dedupeKey: key, kind: 'test', to: { staffId: s.id }, text: 'Hello' }); return ok(undefined) })
    expect(await notificationsByKey(key)).toHaveLength(1)
  })

  it('two concurrent retries still create one', async () => {
    const s = await mkStaff()
    const key = uniq('evt')
    const rc = await sa()
    await Promise.all([1, 2, 3, 4].map(() => runCommand(rc, async c => { await notify(c.tx, { dedupeKey: key, kind: 'test', to: { staffId: s.id }, text: 'Hello' }); return ok(undefined) })))
    expect(await notificationsByKey(key)).toHaveLength(1)
  })

  it('a refused or failed command leaves no notification behind', async () => {
    const s = await mkStaff()
    const key = uniq('evt')
    const rc = await sa()
    const r = await runCommand(rc, async c => { await notify(c.tx, { dedupeKey: key, kind: 'test', to: { staffId: s.id }, text: 'x' }); return fail.conflict('no') })
    expect(r.ok).toBe(false)
    expect(await notificationsByKey(key)).toHaveLength(0)
  })

  it('email stays pending (delivery is Stage 5) and never affects the result', async () => {
    const s = await mkStaff()
    const key = uniq('evt')
    await runCommand(await sa(), async c => { await notify(c.tx, { dedupeKey: key, kind: 'test', to: { staffId: s.id }, text: 'x' }); return ok(undefined) })
    expect((await admin().query(`SELECT email_status FROM notification WHERE dedupe_key = $1`, [key])).rows[0].email_status).toBe('pending')
  })
})

describe('who sees a notification', () => {
  it('a person sees their own; a role at a site is seen only by that role within that site; a capability reaches its holders', async () => {
    const [siteA, siteB] = [await newSite(), await newSite()]
    const aaA = await makeUser({ roles: [{ role: 'AA', siteId: siteA }] })
    const aaB = await makeUser({ roles: [{ role: 'AA', siteId: siteB }] })
    const res = await makeUser({ roles: [{ role: 'Res' }] })
    const rc = await sa()
    const tag = uniq('v')
    await runCommand(rc, async c => {
      await notify(c.tx, { dedupeKey: `${tag}:own`, kind: 't', to: { staffId: res.staffId }, text: 'for the resident' })
      await notify(c.tx, { dedupeKey: `${tag}:aa-a`, kind: 't', to: { role: 'AA', siteId: siteA }, text: 'for AA at A' })
      await notify(c.tx, { dedupeKey: `${tag}:all-aa`, kind: 't', to: { role: 'AA' }, text: 'for every AA' })
      return ok(undefined)
    })
    const texts = async (u: { staffId: string }, role: 'AA' | 'Res', sites: string[]) =>
      (await listNotifications(getDb(), { role, caps: [], sites, staffId: u.staffId }, { limit: 200 })).filter(n => n.dedupeKey.startsWith(tag)).map(n => n.text).sort()
    expect(await texts(res, 'Res', [])).toEqual(['for the resident'])
    expect(await texts(aaA, 'AA', [siteA])).toEqual(['for AA at A', 'for every AA'])
    expect(await texts(aaB, 'AA', [siteB])).toEqual(['for every AA'])
    expect(await unreadCount(getDb(), { role: 'AA', caps: [], sites: [siteA], staffId: aaA.staffId })).toBeGreaterThanOrEqual(2)
  })

  it('the API lists them and marking read touches only what the actor can see', async () => {
    const res = await makeUser({ roles: [{ role: 'Res' }] })
    const other = await makeUser({ roles: [{ role: 'Res' }] })
    const tag = uniq('api')
    await runCommand(await sa(), async c => {
      await notify(c.tx, { dedupeKey: `${tag}:1`, kind: 't', to: { staffId: res.staffId }, text: 'mine' })
      await notify(c.tx, { dedupeKey: `${tag}:2`, kind: 't', to: { staffId: other.staffId }, text: 'theirs' })
      return ok(undefined)
    })
    const cookie = await signIn(res)
    const l = await call(list, { cookie })
    expect(l.status).toBe(200)
    expect(l.body.data.items.map((i: any) => i.text)).toContain('mine')
    expect(l.body.data.items.map((i: any) => i.text)).not.toContain('theirs')
    const theirId = (await admin().query(`SELECT id FROM notification WHERE dedupe_key = $1`, [`${tag}:2`])).rows[0].id
    const r = await call(read, { cookie, body: { ids: [theirId] } })
    expect(r.body.data.marked).toBe(0)
    expect((await admin().query(`SELECT read_at FROM notification WHERE id = $1`, [theirId])).rows[0].read_at).toBeNull()
    expect((await call(read, { cookie, body: {} })).body.data.marked).toBeGreaterThanOrEqual(1)
  })
})
