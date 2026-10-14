/**
 * Arrangement for the cross-site transfer tests (WP-K, D-104): two sites with distinct names, each with its own Accommodation Admin
 * and Reception, a second Accommodation Admin per site (the independent approver), a third site that must see nothing, and a
 * resident with an active stay in the source site.
 */
import { admin, uniq } from '../harness'
import { as, day, mkBed, mkRoom, mkStay, person, residents, world, type Person } from './helpers'
import { approveTransfer } from '@/server/commands/stays/decideTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'

export const nameOfSite = async (siteId: string) => (await admin().query<{ name: string }>(`SELECT name FROM site WHERE id = $1`, [siteId])).rows[0].name

/** A world whose site has a recognisable name. */
export async function namedWorld(label: string, beds = 3) {
  const w = await world({ beds })
  const name = `${label} ${uniq('site')}`
  await admin().query(`UPDATE site SET name = $2 WHERE id = $1`, [w.siteId, name])
  return { ...w, name }
}

export async function cross(o: { srcBeds?: number; dstBeds?: number; stay?: { from?: string; to?: string | null } } = {}) {
  const src = await namedWorld('Source', o.srcBeds ?? 3)
  const dst = await namedWorld('Destination', o.dstBeds ?? 3)
  const third = await namedWorld('Third', 1)
  const srcAa2 = await person('AA', { siteIds: [src.siteId] })
  const dstAa2 = await person('AA', { siteIds: [dst.siteId] })
  const [res] = await residents(1)
  const s = await mkStay({ bedId: src.bedIds[0], staffId: res.staffId, from: o.stay?.from ?? day(-5), to: o.stay?.to === undefined ? day(30) : o.stay.to })
  return { src, dst, third, srcAa2, dstAa2, res, ...s }
}
export type Cross = Awaited<ReturnType<typeof cross>>

export const xreq = (stayId: string, destinationBedId: string | null, destinationSiteId: string | null = null, reason = 'Closer to my new project') =>
  ({ stayId, destinationBedId, destinationSiteId, reason, neededBy: null, linkedExtensionId: null })

/** The resident asks for a bed in the destination site. */
export async function requested(sc: Cross, bedIndex: number | null = 1): Promise<string> {
  const r = await requestTransfer(sc.res.rc, xreq(sc.stayId, bedIndex === null ? null : sc.dst.bedIds[bedIndex], bedIndex === null ? sc.dst.siteId : null))
  if (!r.ok) throw new Error('request failed: ' + r.reason)
  return r.data.id
}

/** Both keys, from two different Accommodation Admins; the destination one chooses the bed. */
export async function approvedByBoth(sc: Cross, id: string, destinationBedId: string | null = null): Promise<void> {
  const a = await approveTransfer(sc.src.aa.rc, { id, destinationBedId: null, note: null })
  if (!a.ok) throw new Error('source approval failed: ' + a.reason)
  const b = await approveTransfer(sc.dst.aa.rc, { id, destinationBedId, note: null })
  if (!b.ok) throw new Error('destination approval failed: ' + b.reason)
}

export async function twoStays() {
  const src = await namedWorld('Source', 3)
  const dst = await namedWorld('Destination', 3)
  const srcAa2 = await person('AA', { siteIds: [src.siteId] })
  const dstAa2 = await person('AA', { siteIds: [dst.siteId] })
  const [ra, rb] = await residents(2)
  const a = await mkStay({ bedId: src.bedIds[0], staffId: ra.staffId, from: day(-5), to: day(30) })
  const b = await mkStay({ bedId: dst.bedIds[0], staffId: rb.staffId, from: day(-2), to: day(40) })
  return { src, dst, srcAa2, dstAa2, ra, rb, a, b }
}
export type TwoStays = Awaited<ReturnType<typeof twoStays>>

/** A cross-site swap raised by the source site's Accommodation Admin with both residents' consent already recorded. */
export async function swapRequested(sc: TwoStays): Promise<string> {
  const c = { via: 'in_person' as const, note: null }
  const r = await requestSwap(sc.src.aa.rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'Friends want to swap sites', neededBy: null, consentFirst: c, consentSecond: c })
  if (!r.ok) throw new Error('swap request failed: ' + r.reason)
  return r.data.id
}

export { as, mkBed, mkRoom }
export type { Person }
