/**
 * AT-035 (P-03, P-04, P-05): the PROPOSED key rules, each in BOTH states. Every one is pending client sign-off and sits behind a setting:
 *   keys.office_hours / keys.enforce_office_hours  (P-03, enforcement ships OFF, the flag is always recorded)
 *   keys.damage_evidence_required                  (P-04, ships OFF)
 *   keys.resident_may_report_lost                  (P-05, ships OFF)
 * Runs in a private database: these are GLOBAL settings, and the shared test database is used by every test file at once.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { call, createIsolated, signIn } from '../access/isolated'
import { clockAt, isoWorld, PNG, uniq, type IsoPerson } from './iso-world'
import { foundItem, issueItem, markDamaged, markLost, replaceItem, retireItem, returnItem } from '@/server/commands/keys/movements'
import { reportOwnLost } from '@/server/commands/keys/ownLost'
import { isAfterHours } from '@/server/commands/keys/hours'
import { getItemDetail, listItems, myKeys } from '@/server/queries/keys/items'
import { attach } from '@/server/attachments'
import { CONFIG, getConfig } from '@/server/config/registry'
import { getDb } from '@/server/db/client'
import { GET as listRoute } from '../../../app/api/v1/keys/route'
import { POST as reportRoute } from '../../../app/api/v1/keys/[id]/report-lost/route'
import { POST as returnRoute } from '../../../app/api/v1/keys/[id]/return/route'
import { POST as foundRoute } from '../../../app/api/v1/keys/[id]/found/route'

const iso = await createIsolated()
afterAll(async () => {
  // pg-pool's end() resolves before the sockets are closed, and close() then drops the database WITH (FORCE): wait for the sockets first.
  const end = iso.admin.end.bind(iso.admin)
  iso.admin.end = (async () => { await end(); await new Promise(r => setTimeout(r, 250)) }) as typeof iso.admin.end
  await iso.close()
})
const w = isoWorld(iso)

const IN_HOURS = '2026-10-14T09:42:00Z'
const LATE = '2026-10-14T21:30:00Z'   // 21:30 in UTC: after 20:00

async function scene(o: { tz?: string; beds?: number } = {}) {
  const p = await w.mkProperty({ beds: o.beds ?? 2, tz: o.tz })
  const rec = await w.person('Rec', { siteIds: [p.siteId] })
  const aa = await w.person('AA', { siteIds: [p.siteId] })
  const sa = await w.person('SA')
  const night = await w.person('Sec', { siteIds: [p.siteId], caps: ['NightKeys'] })
  const res = await w.person('Res')
  await w.mkStay({ staffId: res.staffId, bedId: p.bedIds[0] })
  const itemId = await w.mkItem({ siteId: p.siteId, bedId: p.bedIds[0] })
  return { ...p, rec, aa, sa, night, res, itemId }
}
const at = (p: IsoPerson, iso8: string): IsoPerson => w.withClock(p, clockAt(iso8))
const issue = (by: IsoPerson, itemId: string, staffId: string) => issueItem(by.rc, { itemId, staffId, dueBack: null, note: null })

/** Turns a global setting on or off for the length of one test, then puts it back to its shipped default. */
async function withSetting<T>(key: keyof typeof CONFIG, value: unknown, fn: () => Promise<T>): Promise<T> {
  await w.setConfig(key, value)
  try { return await fn() } finally { await w.setConfig(key, CONFIG[key].default) }
}

describe('shipped defaults (all three proposals are pending client sign-off and ship as written)', () => {
  it('enforcement OFF, damage evidence OFF, resident report OFF; office hours 08:00 to 20:00; each flagged as a proposal', async () => {
    const db = getDb()
    expect(await getConfig(db, 'keys.enforce_office_hours')).toBe(false)
    expect(await getConfig(db, 'keys.damage_evidence_required')).toBe(false)
    expect(await getConfig(db, 'keys.resident_may_report_lost')).toBe(false)
    expect(await getConfig(db, 'keys.office_hours')).toEqual({ from: '08:00', to: '20:00' })
    expect(CONFIG['keys.enforce_office_hours'].proposed).toBe('P-03')
    expect(CONFIG['keys.office_hours'].proposed).toBe('P-03')
    expect(CONFIG['keys.damage_evidence_required'].proposed).toBe('P-04')
    expect(CONFIG['keys.resident_may_report_lost'].proposed).toBe('P-05')
  })
})

describe('AT-035 P-03: office hours, the flag (always) and the rule (only when enforced)', () => {
  it('OFF (the default): nothing is restricted. An after-hours movement is only FLAGGED, in the history and in the audit row', async () => {
    const s = await scene()
    const r = await issue(at(s.rec, LATE), s.itemId, s.res.staffId)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const back = await returnItem(at(s.rec, '2026-10-14T21:45:00Z').rc, { itemId: s.itemId, note: null })
    expect(back.ok).toBe(true)
    expect((await w.events(s.itemId)).map(e => [e.kind, e.after_hours])).toEqual([['issued', true], ['returned', true]])
    const a = await w.audits(s.itemId)
    expect(a.map(x => [x.action, x.after.afterHours])).toEqual([['keys.item.issued', true], ['keys.item.returned', true]])
    // inside the hours the same movements are not flagged
    const ok1 = await issue(s.rec, s.itemId, s.res.staffId)
    expect(ok1.ok).toBe(true)
    expect((await w.events(s.itemId)).at(-1)).toMatchObject({ kind: 'issued', after_hours: false })
  })

  it('every kind of movement records the flag: issue, return, lost, damaged, found, retire, replace (and the replacement\'s own issue)', async () => {
    const s = await scene({ beds: 3 })
    const late = (p: IsoPerson) => at(p, LATE).rc
    // issue + return
    await issueItem(late(s.rec), { itemId: s.itemId, staffId: s.res.staffId, dueBack: null, note: null })
    await returnItem(late(s.rec), { itemId: s.itemId, note: null })
    // lost + found
    await issueItem(late(s.rec), { itemId: s.itemId, staffId: s.res.staffId, dueBack: null, note: null })
    await markLost(late(s.rec), { itemId: s.itemId, note: 'Dropped somewhere' })
    await foundItem(late(s.rec), { itemId: s.itemId, to: 'cabinet', note: null })
    expect((await w.events(s.itemId)).map(e => [e.kind, e.after_hours])).toEqual([
      ['issued', true], ['returned', true], ['issued', true], ['lost', true], ['found', true],
    ])
    // damaged + replace (new key issued to the same holder) + retire
    await issueItem(late(s.rec), { itemId: s.itemId, staffId: s.res.staffId, dueBack: null, note: null })
    await markDamaged(late(s.rec), { itemId: s.itemId, note: 'Bent', attachmentIds: [] })
    const rep = await replaceItem(late(s.aa), { itemId: s.itemId, newCode: uniq('NEW'), note: null })
    expect(rep.ok, JSON.stringify(rep)).toBe(true)
    if (!rep.ok) return
    expect((await w.events(s.itemId)).slice(-2).map(e => [e.kind, e.after_hours])).toEqual([['damaged', true], ['replaced', true]])
    expect((await w.events(rep.data.newId)).map(e => [e.kind, e.after_hours])).toEqual([['issued', true]])
    const spare = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[1] })
    expect((await retireItem(late(s.aa), { itemId: spare, reason: 'Worn out' })).ok).toBe(true)
    expect((await w.events(spare)).map(e => [e.kind, e.after_hours])).toEqual([['retired', true]])
    // and every audit row of these movements carries the flag
    for (const row of [...(await w.audits(s.itemId)), ...(await w.audits(spare))].filter(x => x.action !== 'keys.item.created')) expect(row.after.afterHours, row.action).toBe(true)
  })

  it('the edges of the window, in the site\'s own time: from is inside, to is outside; midnight crossing; zones with an offset', () => {
    const h = { from: '08:00', to: '20:00' }
    const z = (iso8: string, tz: string, hours = h) => isAfterHours(new Date(iso8), tz, hours)
    expect(z('2026-10-14T07:59:59Z', 'UTC')).toBe(true)
    expect(z('2026-10-14T08:00:00Z', 'UTC')).toBe(false)        // exactly on `from`: inside
    expect(z('2026-10-14T19:59:59Z', 'UTC')).toBe(false)
    expect(z('2026-10-14T20:00:00Z', 'UTC')).toBe(true)         // exactly on `to`: outside
    expect(z('2026-10-14T00:00:00Z', 'UTC')).toBe(true)         // local midnight reads 00:00, not 24:00
    // a window that spans midnight
    const night = { from: '22:00', to: '06:00' }
    expect(z('2026-10-14T21:59:59Z', 'UTC', night)).toBe(true)
    expect(z('2026-10-14T22:00:00Z', 'UTC', night)).toBe(false)
    expect(z('2026-10-15T00:00:00Z', 'UTC', night)).toBe(false)
    expect(z('2026-10-15T05:59:59Z', 'UTC', night)).toBe(false)
    expect(z('2026-10-15T06:00:00Z', 'UTC', night)).toBe(true)
    expect(z('2026-10-14T12:00:00Z', 'UTC', night)).toBe(true)
    // to equal to from spans midnight too: the whole day is open (never after hours)
    expect(z('2026-10-14T03:00:00Z', 'UTC', { from: '08:00', to: '08:00' })).toBe(false)
    // a zone with a fixed offset and no daylight saving: Dubai is UTC+4
    expect(z('2026-10-14T03:59:59Z', 'Asia/Dubai')).toBe(true)  // 07:59:59 local
    expect(z('2026-10-14T04:00:00Z', 'Asia/Dubai')).toBe(false) // 08:00:00 local
    expect(z('2026-10-14T15:59:59Z', 'Asia/Dubai')).toBe(false) // 19:59:59 local
    expect(z('2026-10-14T16:00:00Z', 'Asia/Dubai')).toBe(true)  // 20:00:00 local
    // a half-hour offset: India is UTC+5:30
    expect(z('2026-10-14T02:29:59Z', 'Asia/Kolkata')).toBe(true)
    expect(z('2026-10-14T02:30:00Z', 'Asia/Kolkata')).toBe(false)
    // the local day, not the server's: 22:30 UTC is 02:30 the next morning in Dubai (closed) but 18:30 in New York (open)
    expect(z('2026-10-14T22:30:00Z', 'Asia/Dubai')).toBe(true)
    expect(z('2026-10-14T22:30:00Z', 'America/New_York')).toBe(false)   // 18:30 EDT
    // a zone with daylight saving follows the zone database: London is UTC+1 in October and UTC+0 in January
    expect(z('2026-10-14T07:00:00Z', 'Europe/London')).toBe(false)      // 08:00 BST
    expect(z('2027-01-14T07:00:00Z', 'Europe/London')).toBe(true)       // 07:00 GMT
  })

  it('the flag follows the SITE\'s time zone and the per-site office hours', async () => {
    const dubai = await scene({ tz: 'Asia/Dubai' })
    // 17:00Z is 21:00 in Dubai: after hours there, although it is 17:00 in UTC
    expect((await issue(at(dubai.rec, '2026-10-14T17:00:00Z'), dubai.itemId, dubai.res.staffId)).ok).toBe(true)
    expect((await w.events(dubai.itemId)).at(-1)).toMatchObject({ after_hours: true })
    // 05:00Z is 09:00 in Dubai: inside the hours
    expect((await returnItem(at(dubai.rec, '2026-10-15T05:00:00Z').rc, { itemId: dubai.itemId, note: null })).ok).toBe(true)
    expect((await w.events(dubai.itemId)).at(-1)).toMatchObject({ kind: 'returned', after_hours: false })
    // a site with its own hours (a night desk 22:00 to 06:00)
    const nightSite = await scene()
    await w.setConfig('keys.office_hours', { from: '22:00', to: '06:00' }, nightSite.siteId)
    expect((await issue(at(nightSite.rec, '2026-10-14T23:00:00Z'), nightSite.itemId, nightSite.res.staffId)).ok).toBe(true)
    expect((await w.events(nightSite.itemId)).at(-1)).toMatchObject({ kind: 'issued', after_hours: false })
    expect((await returnItem(at(nightSite.rec, '2026-10-15T12:00:00Z').rc, { itemId: nightSite.itemId, note: null })).ok).toBe(true)
    expect((await w.events(nightSite.itemId)).at(-1)).toMatchObject({ kind: 'returned', after_hours: true })
  })

  it('ON: Reception is refused out of hours (reason, owner, next action) for every movement, and nothing is written', async () => {
    await withSetting('keys.enforce_office_hours', true, async () => {
      const s = await scene()
      const held = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId })
      const lostOne = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'lost' })
      const rec = at(s.rec, LATE).rc
      const refused = [
        await issueItem(rec, { itemId: s.itemId, staffId: s.res.staffId, dueBack: null, note: null }),
        await returnItem(rec, { itemId: held, note: null }),
        await markLost(rec, { itemId: held, note: 'Gone' }),
        await markDamaged(rec, { itemId: held, note: 'Bent', attachmentIds: [] }),
        await foundItem(rec, { itemId: lostOne, to: 'cabinet', note: null }),
      ]
      for (const r of refused) {
        expect(r).toMatchObject({ ok: false, code: 'forbidden', detail: { reason: 'outside_office_hours', from: '08:00', to: '20:00' } })
        if (!r.ok) { expect(r.reason).toMatch(/closed/i); expect(r.owner).toMatch(/Security/); expect(r.next).toMatch(/Night Keys/) }
      }
      expect(await w.itemRow(s.itemId)).toMatchObject({ status: 'in_cabinet' })
      expect(await w.itemRow(held)).toMatchObject({ status: 'issued' })
      expect(await w.itemRow(lostOne)).toMatchObject({ status: 'lost' })
      expect(await w.events(s.itemId)).toHaveLength(0)
      expect(await w.events(held)).toHaveLength(0)
      // the same people inside the hours are not restricted
      expect((await issue(s.rec, s.itemId, s.res.staffId)).ok).toBe(true)
    })
  })

  it('ON: the edges. Exactly on `from` is allowed, one second before is not; one second before `to` is allowed, exactly on `to` is not', async () => {
    await withSetting('keys.enforce_office_hours', true, async () => {
      const s = await scene()
      const tryAt = async (iso8: string) => returnItem(at(s.rec, iso8).rc, { itemId: s.itemId, note: null }).then(r => r.ok || (r.detail as { reason?: string })?.reason !== 'outside_office_hours')
      // the item is in the cabinet, so a return is refused for ANOTHER reason when the desk is open: that still proves the hours did not stop it
      expect(await tryAt('2026-10-14T07:59:59Z')).toBe(false)
      expect(await tryAt('2026-10-14T08:00:00Z')).toBe(true)
      expect(await tryAt('2026-10-14T19:59:59Z')).toBe(true)
      expect(await tryAt('2026-10-14T20:00:00Z')).toBe(false)
    })
  })

  it('ON: a window that spans midnight, and a site in Dubai', async () => {
    await withSetting('keys.enforce_office_hours', true, async () => {
      const s = await scene()
      await w.setConfig('keys.office_hours', { from: '22:00', to: '06:00' }, s.siteId)
      expect((await issue(at(s.rec, '2026-10-14T23:30:00Z'), s.itemId, s.res.staffId)).ok).toBe(true)     // inside 22:00 to 06:00
      const back = await returnItem(at(s.rec, '2026-10-15T12:00:00Z').rc, { itemId: s.itemId, note: null })  // noon: closed
      expect(back).toMatchObject({ ok: false, code: 'forbidden', detail: { reason: 'outside_office_hours', from: '22:00', to: '06:00' } })
      const d = await scene({ tz: 'Asia/Dubai' })
      expect((await issue(at(d.rec, '2026-10-14T16:00:00Z'), d.itemId, d.res.staffId)).ok).toBe(false)    // 20:00 local: closed
      expect((await issue(at(d.rec, '2026-10-14T15:59:59Z'), d.itemId, d.res.staffId)).ok).toBe(true)     // 19:59:59 local: open
    })
  })

  it('ON: Night Keys holders, Accommodation Admin and Super Admin are always allowed (and flagged); a Read-only Manager is not a key holder at all', async () => {
    await withSetting('keys.enforce_office_hours', true, async () => {
      const s = await scene({ beds: 3 })
      const other = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0] })
      const third = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0] })
      expect((await issue(at(s.night, LATE), s.itemId, s.res.staffId)).ok).toBe(true)
      expect((await issue(at(s.aa, LATE), other, s.res.staffId)).ok).toBe(true)
      expect((await issue(at(s.sa, LATE), third, s.res.staffId)).ok).toBe(true)
      for (const id of [s.itemId, other, third]) expect((await w.events(id)).at(-1)).toMatchObject({ kind: 'issued', after_hours: true })
      // returning at night: the Night Keys holder can
      expect((await returnItem(at(s.night, '2026-10-14T22:00:00Z').rc, { itemId: s.itemId, note: null })).ok).toBe(true)
      // a Reception officer WITH the Night Keys capability is allowed too: the capability adds the action
      const recNight = await w.person('Rec', { siteIds: [s.siteId], caps: ['NightKeys'] })
      expect((await returnItem(at(recNight, '2026-10-14T22:10:00Z').rc, { itemId: other, note: null })).ok).toBe(true)
      // Night Keys at another site does not help here
      const elsewhere = await w.mkProperty({ beds: 1 })
      const foreignNight = await w.person('Sec', { siteIds: [elsewhere.siteId], caps: ['NightKeys'] })
      expect(await returnItem(at(foreignNight, LATE).rc, { itemId: third, note: null })).toMatchObject({ ok: false, code: 'not_found' })
      const mgr = await w.person('Mgr', { siteIds: [s.siteId] })
      expect(await returnItem(at(mgr, LATE).rc, { itemId: third, note: null })).toMatchObject({ ok: false, code: 'forbidden' })
    })
  })

  it('OFF again: the same Reception officer is allowed out of hours (the rule is the setting, nothing else)', async () => {
    const s = await scene()
    await withSetting('keys.enforce_office_hours', true, async () => {
      expect((await issue(at(s.rec, LATE), s.itemId, s.res.staffId)).ok).toBe(false)
    })
    expect((await issue(at(s.rec, LATE), s.itemId, s.res.staffId)).ok).toBe(true)
  })

  it('the flag is in the item history, in the "Out of hours" desk filter and in the list API; a resident never sees it', async () => {
    const s = await scene({ beds: 3 })
    const lateItem = s.itemId
    const dayItem = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0] })
    await issue(at(s.rec, LATE), lateItem, s.res.staffId)
    await issue(s.rec, dayItem, s.res.staffId)
    const detail = await getItemDetail(s.rec.rc.actor, lateItem)
    expect(detail!.events.map(e => e.afterHours)).toEqual([true])
    expect(detail!.lastAfterHours).toBe(true)
    expect((await getItemDetail(s.rec.rc.actor, dayItem))!.events.map(e => e.afterHours)).toEqual([false])
    const out = (await listItems(s.rec.rc.actor, { afterHours: true })).rows.map(r => r.id)
    expect(out).toContain(lateItem)
    expect(out).not.toContain(dayItem)
    const all = (await listItems(s.rec.rc.actor, {})).rows.map(r => r.id)
    expect(all).toEqual(expect.arrayContaining([lateItem, dayItem]))
    // through the real route
    const cookie = await signIn({ username: s.rec.username, password: 'Correct-horse-9' })
    const viaApi = await call(listRoute, { path: '/api/v1/keys?afterHours=true', cookie })
    expect(viaApi.status).toBe(200)
    expect(viaApi.body.data.rows.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([lateItem]))
    expect(viaApi.body.data.rows.map((r: { id: string }) => r.id)).not.toContain(dayItem)
    // the resident who holds it: the item and its history, with no after-hours facts
    const mine = await getItemDetail(s.res.rc.actor, lateItem)
    expect(mine).toBeDefined()
    expect(mine!.lastAfterHours).toBe(false)
    expect(mine!.events.every(e => e.afterHours === false)).toBe(true)
    expect((await myKeys(s.res.rc.actor)).every(r => r.lastAfterHours === false)).toBe(true)
  })
})

describe('AT-035 P-04: evidence to mark a key damaged', () => {
  const png = (id: string, by: IsoPerson) => attach(by.rc, { entityType: 'handover_item', entityId: id, filename: 'bent.png', contentType: 'image/png', dataBase64: PNG.toString('base64') })

  it('OFF (the default): evidence is optional, as before', async () => {
    const s = await scene()
    await issue(s.rec, s.itemId, s.res.staffId)
    const r = await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent in the lock' })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(await w.itemRow(s.itemId)).toMatchObject({ status: 'damaged', holder_staff_id: s.res.staffId })
  })

  it('ON: a damaged item needs at least one file attached to it, with a clear field error; nothing is written without it', async () => {
    await withSetting('keys.damage_evidence_required', true, async () => {
      const s = await scene()
      await issue(s.rec, s.itemId, s.res.staffId)
      const before = (await w.events(s.itemId)).length
      for (const attachmentIds of [undefined, [] as string[]]) {
        const r = await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent in the lock', attachmentIds })
        expect(r).toMatchObject({ ok: false, code: 'invalid', fields: { attachmentIds: expect.stringMatching(/photo or file/i) }, detail: { reason: 'evidence_required' } })
        if (!r.ok) { expect(r.owner).toBeTruthy(); expect(r.next).toMatch(/photo/i) }
      }
      expect(await w.itemRow(s.itemId)).toMatchObject({ status: 'issued' })
      expect(await w.events(s.itemId)).toHaveLength(before)
      // a file that belongs to another item does not count (the existing check still applies)
      const foreign = await w.mkItem({ siteId: s.siteId })
      const stray = await png(foreign, s.aa)
      if (!stray.ok) throw new Error('attach failed')
      expect(await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent', attachmentIds: [stray.data.id] })).toMatchObject({ ok: false, code: 'invalid', fields: { attachmentIds: expect.any(String) } })
      // with the photo it works
      const up = await png(s.itemId, s.rec)
      if (!up.ok) throw new Error('attach failed')
      const ok = await markDamaged(s.rec.rc, { itemId: s.itemId, note: 'Bent in the lock', attachmentIds: [up.data.id] })
      expect(ok.ok, JSON.stringify(ok)).toBe(true)
      expect(await w.itemRow(s.itemId)).toMatchObject({ status: 'damaged' })
      expect((await w.audits(s.itemId)).at(-1)!.after.attachmentIds).toEqual([up.data.id])
    })
  })

  it('ON: lost stays note-only; so does an item from the cabinet marked lost', async () => {
    await withSetting('keys.damage_evidence_required', true, async () => {
      const s = await scene()
      await issue(s.rec, s.itemId, s.res.staffId)
      expect((await markLost(s.rec.rc, { itemId: s.itemId, note: 'Dropped in the sea' })).ok).toBe(true)
      const cabinet = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[1] })
      expect((await markLost(s.rec.rc, { itemId: cabinet, note: 'Cannot find it in the cabinet' })).ok).toBe(true)
    })
  })
})

describe('AT-035 P-05: a resident reports their own key lost', () => {
  const heldBy = async (res: IsoPerson, s: Awaited<ReturnType<typeof scene>>) => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: res.staffId, code: uniq('K') })

  it('OFF (the default): refused with a clear reason, owner Reception and next action "Tell Reception"; nothing changes, nobody is notified', async () => {
    const s = await scene()
    const item = await heldBy(s.res, s)
    const r = await reportOwnLost(s.res.rc, { itemId: item, note: 'I lost it on the beach' })
    expect(r).toMatchObject({ ok: false, code: 'forbidden', owner: 'Reception', next: 'Tell Reception', detail: { reason: 'policy_not_in_force' } })
    if (!r.ok) expect(r.reason).toMatch(/not in force/i)
    expect(await w.itemRow(item)).toMatchObject({ status: 'issued', holder_staff_id: s.res.staffId })
    expect(await w.events(item)).toHaveLength(0)
    expect(await w.audits(item)).toHaveLength(0)
    expect(await w.notesAbout(item)).toHaveLength(0)
    // through the route: the same clear refusal
    const cookie = await signIn({ username: s.res.username, password: 'Correct-horse-9' })
    const viaApi = await call(reportRoute, { path: `/api/v1/keys/${item}/report-lost`, body: { note: 'Lost on the beach' }, cookie, params: { id: item } })
    expect(viaApi.status).toBe(403)
    expect(viaApi.body).toMatchObject({ owner: 'Reception', next: 'Tell Reception' })
  })

  it('OFF or ON, another resident\'s item and an item in the cabinet are "not found": nothing about what others hold is revealed', async () => {
    for (const on of [false, true]) {
      await withSetting('keys.resident_may_report_lost', on, async () => {
        const s = await scene()
        const theirs = await w.person('Res')
        const theirItem = await heldBy(theirs, s)
        const inCabinet = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[1] })
        for (const id of [theirItem, inCabinet, crypto.randomUUID()]) {
          expect(await reportOwnLost(s.res.rc, { itemId: id, note: 'It is mine, honest' }), `setting ${on}`).toMatchObject({ ok: false, code: 'not_found' })
        }
        expect(await w.itemRow(theirItem)).toMatchObject({ status: 'issued' })
      })
    }
  })

  it('ON: the item goes issued -> lost, the holder is kept, the event is `lost` with on_behalf false and the note, it is audited, Reception and the AA are told once', async () => {
    await withSetting('keys.resident_may_report_lost', true, async () => {
      const s = await scene()
      const item = await heldBy(s.res, s)
      const r = await reportOwnLost(s.res.rc, { itemId: item, note: 'Fell out of my pocket at the pool' })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(await w.itemRow(item)).toMatchObject({ status: 'lost', holder_staff_id: s.res.staffId })
      const ev = await w.events(item)
      expect(ev).toEqual([{ kind: 'lost', staff_id: s.res.staffId, actor_user_id: s.res.userId, on_behalf: false, note: 'Fell out of my pocket at the pool', after_hours: false }])
      const a = await w.audits(item)
      expect(a).toHaveLength(1)
      expect(a[0]).toMatchObject({ action: 'keys.item.lost', actor_role: 'Res', reason: 'Fell out of my pocket at the pool', site_id: s.siteId })
      expect(a[0].before).toMatchObject({ status: 'issued', holderStaffId: s.res.staffId })
      expect(a[0].after).toMatchObject({ status: 'lost', holderStaffId: s.res.staffId, reportedBy: 'holder' })
      const n = (await w.notes('handover:')).filter(x => x.kind === 'keys.lost' && x.dedupe_key.includes(':lost:') && x.text.includes('reported lost'))
        .filter(x => x.site_id === s.siteId)
      expect(n.map(x => x.to_role).sort()).toEqual(['AA', 'Rec'])
      expect(new Set(n.map(x => x.dedupe_key)).size).toBe(2)
      // it is still the resident's: it shows on their list as lost, never as returned
      expect((await myKeys(s.res.rc.actor)).find(i => i.id === item)).toMatchObject({ status: 'lost' })
      // a second report is a conflict, not a second event
      expect(await reportOwnLost(s.res.rc, { itemId: item, note: 'I said so already' })).toMatchObject({ ok: false, code: 'conflict' })
      expect(await w.events(item)).toHaveLength(1)
    })
  })

  it('ON: the note is mandatory; a damaged item and a retired one cannot be "reported lost"', async () => {
    await withSetting('keys.resident_may_report_lost', true, async () => {
      const s = await scene()
      const item = await heldBy(s.res, s)
      expect(await reportOwnLost(s.res.rc, { itemId: item, note: '' } as never)).toMatchObject({ ok: false })   // the route's schema refuses it first; the command is not reached with an empty note
      const cookie = await signIn({ username: s.res.username, password: 'Correct-horse-9' })
      const empty = await call(reportRoute, { path: `/api/v1/keys/${item}/report-lost`, body: { note: ' ' }, cookie, params: { id: item } })
      expect(empty.status).toBe(422)
      expect(empty.body.fields).toHaveProperty('note')
      expect(await w.itemRow(item)).toMatchObject({ status: 'issued' })
      const damaged = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'damaged' })
      expect(await reportOwnLost(s.res.rc, { itemId: damaged, note: 'Actually lost' })).toMatchObject({ ok: false, code: 'conflict' })
      expect(await w.itemRow(damaged)).toMatchObject({ status: 'damaged' })
    })
  })

  it('ON: the resident can NEVER mark returned or found, or issue, retire, replace, archive or mark damaged: those stay staff only', async () => {
    await withSetting('keys.resident_may_report_lost', true, async () => {
      const s = await scene()
      const item = await heldBy(s.res, s)
      const lost = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'lost' })
      const rc = s.res.rc
      expect(await returnItem(rc, { itemId: item, note: null })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await foundItem(rc, { itemId: lost, to: 'holder', note: null })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await markDamaged(rc, { itemId: item, note: 'Bent' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await markLost(rc, { itemId: item, note: 'Gone' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await retireItem(rc, { itemId: lost, reason: 'Never mind' })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await replaceItem(rc, { itemId: lost, newCode: uniq('NEW'), note: null })).toMatchObject({ ok: false, code: 'forbidden' })
      expect(await issueItem(rc, { itemId: await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0] }), staffId: s.res.staffId, dueBack: null, note: null })).toMatchObject({ ok: false, code: 'forbidden' })
      // and through the real routes
      const cookie = await signIn({ username: s.res.username, password: 'Correct-horse-9' })
      expect((await call(returnRoute, { path: `/api/v1/keys/${item}/return`, body: {}, cookie, params: { id: item } })).status).toBe(403)
      expect((await call(foundRoute, { path: `/api/v1/keys/${lost}/found`, body: { to: 'holder' }, cookie, params: { id: lost } })).status).toBe(403)
      expect(await w.itemRow(item)).toMatchObject({ status: 'issued' })
      expect(await w.itemRow(lost)).toMatchObject({ status: 'lost' })
      // even after reporting its own item lost, staff are the only ones who can resolve it
      expect((await reportOwnLost(rc, { itemId: item, note: 'Lost at the pool' })).ok).toBe(true)
      expect(await foundItem(rc, { itemId: item, to: 'holder', note: null })).toMatchObject({ ok: false, code: 'forbidden' })
      expect((await foundItem(s.rec.rc, { itemId: item, to: 'holder', note: 'Found at the pool' })).ok).toBe(true)
    })
  })

  it('ON: staff cannot use the resident report for someone else; Reception, the AA and a Manager are refused by the policy', async () => {
    await withSetting('keys.resident_may_report_lost', true, async () => {
      const s = await scene()
      const item = await heldBy(s.res, s)
      for (const p of [s.rec, s.aa, s.sa, await w.person('Mgr', { siteIds: [s.siteId] })]) {
        expect(await reportOwnLost(p.rc, { itemId: item, note: 'Reporting for them' })).toMatchObject({ ok: false, code: 'forbidden' })
      }
      expect(await w.itemRow(item)).toMatchObject({ status: 'issued' })
      // a staff member who is also a resident may report their own, as a resident
      const staffRes = await w.person('Res')
      await w.mkStay({ staffId: staffRes.staffId, bedId: s.bedIds[1] })
      const own = await w.mkItem({ siteId: s.siteId, bedId: s.bedIds[1], holderStaffId: staffRes.staffId })
      expect((await reportOwnLost(staffRes.rc, { itemId: own, note: 'Mine, lost' })).ok).toBe(true)
    })
  })

  it('ON: two simultaneous reports of one key: one wins, the other is a conflict, one event, two notifications', async () => {
    await withSetting('keys.resident_may_report_lost', true, async () => {
      const s = await scene()
      const item = await heldBy(s.res, s)
      const results = await Promise.all([1, 2, 3].map(n => reportOwnLost(s.res.rc, { itemId: item, note: `Report ${n}` })))
      expect(results.filter(r => r.ok)).toHaveLength(1)
      expect(results.filter(r => !r.ok).every(r => !r.ok && r.code === 'conflict')).toBe(true)
      expect(await w.events(item)).toHaveLength(1)
    })
  })

  it('ON with the office-hours rule ON: a resident can report at night (the rule is about the desk); it is flagged', async () => {
    await withSetting('keys.enforce_office_hours', true, async () => {
      await withSetting('keys.resident_may_report_lost', true, async () => {
        const s = await scene()
        const item = await heldBy(s.res, s)
        const r = await reportOwnLost(at(s.res, LATE).rc, { itemId: item, note: 'Lost at midnight' })
        expect(r.ok, JSON.stringify(r)).toBe(true)
        expect((await w.events(item))[0]).toMatchObject({ kind: 'lost', after_hours: true, on_behalf: false })
      })
    })
  })

  it('the route guard: only a Resident passes (the contract), others get 403 before the body is read', async () => {
    const s = await scene()
    const item = await heldBy(s.res, s)
    for (const p of [s.rec, s.aa]) {
      const cookie = await signIn({ username: p.username, password: 'Correct-horse-9' })
      expect((await call(reportRoute, { path: `/api/v1/keys/${item}/report-lost`, body: { note: 'x' }, cookie, params: { id: item } })).status).toBe(403)
    }
    expect((await call(reportRoute, { path: `/api/v1/keys/${item}/report-lost`, body: { note: 'x' }, params: { id: item } })).status).toBe(401)
  })
})

describe('AT-035: a failure after the write rolls the whole movement back (the event and the audit share one transaction)', () => {
  type Scene = Awaited<ReturnType<typeof scene>>
  const movements: { name: string; item: (s: Scene) => Promise<string>; run: (s: Scene, id: string, newCode: string) => Promise<{ ok: boolean; code?: string }> }[] = [
    { name: 'issue', item: async s => s.itemId, run: (s, id) => issue(s.rec, id, s.res.staffId) },
    { name: 'return', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId }), run: (s, id) => returnItem(s.rec.rc, { itemId: id, note: null }) },
    { name: 'lost', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId }), run: (s, id) => markLost(s.rec.rc, { itemId: id, note: 'Lost at the pool' }) },
    { name: 'damaged', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId }), run: (s, id) => markDamaged(s.rec.rc, { itemId: id, note: 'Bent in the lock' }) },
    { name: 'found', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'lost' }), run: (s, id) => foundItem(s.rec.rc, { itemId: id, to: 'holder', note: null }) },
    { name: 'retire', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'lost' }), run: (s, id) => retireItem(s.aa.rc, { itemId: id, reason: 'Written off' }) },
    { name: 'replace', item: s => w.mkItem({ siteId: s.siteId, bedId: s.bedIds[0], holderStaffId: s.res.staffId, status: 'damaged' }), run: (s, id, code) => replaceItem(s.aa.rc, { itemId: id, newCode: code, note: null }) },
  ]

  it.each(movements.map(m => [m.name, m] as const))('%s: if the audit row cannot be written after the event, the item, the event log, the audit log and the notifications are all untouched', async (_n, m) => {
    const s = await scene()
    const id = await m.item(s)
    const newCode = uniq('NEW')
    const state = async () => JSON.stringify([await w.itemRow(id), await w.events(id), await w.audits(id), await w.notesAbout(id)])
    const before = await state()
    // The audit table is made to refuse exactly this item's rows. The event is written first, so a refusal proves they stand or fall together.
    await w.q(`CREATE OR REPLACE FUNCTION test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.entity_id = '${id}' THEN RAISE EXCEPTION 'audit refused for the test'; END IF; RETURN NEW; END $f$`)
    await w.q(`CREATE TRIGGER test_refuse_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION test_refuse_audit()`)
    try {
      const r = await m.run(s, id, newCode)
      expect(r).toMatchObject({ ok: false, code: 'internal' })
      expect(await state()).toBe(before)
      expect((await w.q(`SELECT 1 FROM handover_item WHERE lower(code) = lower($1)`, [newCode])).rowCount).toBe(0)   // a replacement is not left behind either
    } finally {
      await w.q(`DROP TRIGGER test_refuse_audit ON audit_event`)
    }
    // with the refusal gone the same movement works, and leaves exactly one event and one audit row for the item
    const r2 = await m.run(s, id, newCode)
    expect(r2.ok, m.name).toBe(true)
    expect((await w.events(id)).length).toBe(1)
    expect((await w.audits(id)).filter(a => a.action !== 'keys.item.created').length).toBe(1)
  })
})
