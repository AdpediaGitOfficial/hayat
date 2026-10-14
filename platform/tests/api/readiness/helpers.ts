/**
 * Arrangement for the WP-J tests (cleaning, final inspection, readiness). Data is created with the superuser pool; actions go through
 * the real commands (direct calls with a FixedClock) or the real routes (with a session) as app_role. Every call builds its own site,
 * so test files run in parallel against one database.
 */
import { admin, grantCapability, makeUser, signIn, type TestUser } from '../harness'
import { FixedClock } from '@/server/clock'
import { rcFor } from '../rc'
import { mkProperty, mkStaff } from '../fixtures3'
import { mkStay, newClock, person, bedState, setBedState, NOW, DAY_MS, type Person } from '../stays/helpers'
import type { Capability, Role } from '@/domain/enums'
import type { RequestContext } from '@/server/command/context'
import { processCheckout } from '@/server/commands/stays/checkout'

export { mkProperty, mkStaff, newClock, person, bedState, setBedState, mkStay, NOW, DAY_MS, signIn }
export { day, notificationsByKey, notificationsFor, auditRows } from '../stays/helpers'
export type { Person }

/**
 * The tasks of a bed in the order they happened. A FixedClock does not move between a failed inspection and the task it opens, so equal
 * timestamps are broken by "the open one is the newer one".
 */
export async function cleaningTasks(bedId: string) {
  return (await admin().query<{ id: string; status: string; reason: string }>(
    `SELECT id, status, reason FROM cleaning_task WHERE bed_id = $1 ORDER BY created_at, (status IN ('open', 'cleaned'))`, [bedId])).rows
}

/** A person who can sign in and clean: a plain staff account (Resident base role) with an ACTIVE Housekeeping grant in the database. */
export async function housekeeper(o: { clock?: FixedClock; grant?: boolean } = {}): Promise<Person & { cookie: () => Promise<string> }> {
  const user = await makeUser({ roles: [{ role: 'Res' }] })
  if (o.grant !== false) await grantCapability(user.id, 'Housekeeping')
  const caps: Capability[] = o.grant === false ? [] : ['Housekeeping']
  return { user, staffId: user.staffId, userId: user.id, rc: rcFor(user.id, { role: 'Res', sites: [], caps, staffId: user.staffId }, o.clock ?? newClock()), cookie: () => signIn(user) }
}

/** Reception or an Accommodation Admin who also holds the Final Inspection capability (D-24); the grant is real, so they can sign in with it. */
export async function inspector(siteId: string, role: Role = 'AA', clock?: FixedClock): Promise<Person & { cookie: () => Promise<string> }> {
  const user = await makeUser({ roles: [{ role, siteId }] })
  await grantCapability(user.id, 'FinalInspection')
  return { user, staffId: user.staffId, userId: user.id, rc: rcFor(user.id, { role, sites: [siteId], caps: ['FinalInspection'], staffId: user.staffId }, clock ?? newClock()), cookie: () => signIn(user) }
}

/** A signed-in-capable person with a real role assignment for the site (the `person` helper of the stays tests only fakes the scope in the command context). */
export async function staffAt(role: Role, siteId: string | null, o: { caps?: Capability[]; clock?: FixedClock } = {}): Promise<Person & { cookie: () => Promise<string> }> {
  const user = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' || !siteId ? { role } : { role, siteId }] })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  return {
    user, staffId: user.staffId, userId: user.id, cookie: () => signIn(user),
    rc: rcFor(user.id, { role, sites: role === 'SA' ? 'all' : siteId ? [siteId] : [], caps: o.caps ?? [], staffId: user.staffId }, o.clock ?? newClock()),
  }
}

/**
 * A site with one room of `beds` beds, Reception and a Super Admin, an inspector and a housekeeper. `used` beds are given a resident
 * and checked out through the REAL checkout command, so the cleaning task and the Needs cleaning state come from WP-F and WP-0.
 */
export async function scene(o: { beds?: number } = {}) {
  const p = await mkProperty({ beds: o.beds ?? 3 })
  const rec = await staffAt('Rec', p.siteId)
  const sa = await staffAt('SA', null)
  const insp = await inspector(p.siteId)
  const hk = await housekeeper()
  return { ...p, rec, sa, insp, hk }
}
export type Scene = Awaited<ReturnType<typeof scene>>

/** Puts a resident in the bed and checks them out for real: the bed becomes Needs cleaning and the task is opened by the checkout. */
export async function vacate(s: Pick<Scene, 'rec'>, bedId: string, resident?: { id: string }) {
  const res = resident ?? (await mkStaff())
  const st = await mkStay({ bedId, staffId: res.id, from: new Date(NOW - 20 * DAY_MS).toISOString().slice(0, 10), to: null })
  const out = await processCheckout(s.rec.rc, { stayId: st.stayId, note: null })
  if (!out.ok) throw new Error(`checkout failed: ${out.reason}`)
  const task = (await cleaningTasks(bedId)).find(t => t.status === 'open')!
  return { taskId: task.id, stayId: st.stayId, residentId: res.id }
}

/** Every required line ticked; `extra` overrides lines. */
export const FULL = { linen: true, surfaces: true, bathroom: true, bins: true }

export async function taskRow(id: string) {
  return (await admin().query<{
    id: string; bed_id: string; status: string; assigned_to_staff: string | null; assigned_by: string | null; cleaned_by_staff: string | null; cleaned_at: Date | null
    checklist: any; inspected_by_staff: string | null; inspected_by: string | null; inspection_note: string | null; reason: string; created_at: Date
  }>(`SELECT * FROM cleaning_task WHERE id = $1`, [id])).rows[0]
}
export async function bedRow(id: string) {
  return (await admin().query<{ state: string; state_reason: string | null }>(`SELECT state, state_reason FROM bed WHERE id = $1`, [id])).rows[0]
}
export async function auditActions(entityId: string) {
  return (await admin().query<{ action: string; reason: string | null; before: any; after: any }>(`SELECT action, reason, before, after FROM audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows
}

/** Runs a handler's command as a request context. */
export const asRc = (p: { rc: RequestContext }) => p.rc
