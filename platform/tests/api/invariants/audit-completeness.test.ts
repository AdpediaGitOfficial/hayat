/**
 * AT-039: audit completeness (D-27, AT-028). Every mutating workflow is run once through its real command.
 *
 *  - success writes EXACTLY the documented audit events, in order, with the acting login and role, the entity type and id, the site where the
 *    workflow has one, the reason where the action takes one, and before/after where it changes state. The events are found by the request id
 *    of the acting context, so parallel tests cannot pollute the result;
 *  - a refused command (a person who may not do it) leaves NO audit row and changes nothing;
 *  - every audit action the code can write is asserted by at least one test (a new action cannot slip in unasserted);
 *  - no route edits or deletes an audit row, and the application's database login is refused UPDATE and DELETE on audit_event.
 * The same-transaction guarantee (a failure after the audit write rolls everything back) is tested against a private database in audit-atomic.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { admin, closeAll, makeUser, PASSWORD, grantCapability } from '../harness'
import { getDb, getPool } from '@/server/db/client'
import { PNG, mkStaff } from '../fixtures3'
import * as RQ from '../requests/helpers'
import * as ST from '../stays/helpers'
import * as EM from '../emergency/helpers'
import * as XT from '../exit/helpers'
import * as KY from '../keys/helpers'
import * as RD from '../readiness/helpers'
import * as WL from '../waitlist/helpers'
import { rcFor } from '../rc'
import type { Result } from '@/server/command/result'
import type { RequestContext } from '@/server/command/context'
import { createSite } from '@/server/commands/property/createSite'
import { updateSite } from '@/server/commands/property/updateSite'
import { createBuilding } from '@/server/commands/property/createBuilding'
import { updateBuilding } from '@/server/commands/property/updateBuilding'
import { createRoom } from '@/server/commands/property/createRoom'
import { updateRoom } from '@/server/commands/property/updateRoom'
import { createBed } from '@/server/commands/property/createBed'
import { blockBed } from '@/server/commands/property/blockBed'
import { unblockBed } from '@/server/commands/property/unblockBed'
import { archiveBed } from '@/server/commands/property/archiveBed'
import { archiveRoom } from '@/server/commands/property/archiveRoom'
import { archiveBuilding } from '@/server/commands/property/archiveBuilding'
import { createStaff } from '@/server/commands/staff/create'
import { updateStaff } from '@/server/commands/staff/update'
import { archiveStaff } from '@/server/commands/staff/archive'
import { createAccount } from '@/server/commands/access/create-account'
import { requestRoleChange } from '@/server/commands/access/request-role-change'
import { decideRoleChange } from '@/server/commands/access/decide-role-change'
import { requestGrant } from '@/server/commands/access/request-grant'
import { decideGrant } from '@/server/commands/access/decide-grant'
import { revokeGrant } from '@/server/commands/access/revoke-grant'
import { deactivateAccount } from '@/server/commands/access/deactivate-account'
import { reactivateAccount } from '@/server/commands/access/reactivate-account'
import { resetPassword } from '@/server/commands/access/reset-password'
import { revokeUserSessions } from '@/server/commands/access/revoke-sessions'
import { setConfig } from '@/server/commands/access/set-config'
import { submitRequest } from '@/server/commands/requests/submit'
import { editRequest, resubmitRequest } from '@/server/commands/requests/edit'
import { cancelRequest as cancelBedRequest } from '@/server/commands/requests/cancel'
import { approveRequest } from '@/server/commands/requests/approve'
import { rejectRequest, requestChanges } from '@/server/commands/requests/decide'
import { declineException, grantException, requestException } from '@/server/commands/requests/exceptions'
import { cancelReservation, extendNoShow } from '@/server/commands/allocation-admin/reservations'
import { addToWaitlist } from '@/server/commands/waitlist/add'
import { leaveWaitlist } from '@/server/commands/waitlist/leave'
import { renewEntry } from '@/server/commands/waitlist/renew'
import { createOffer, withdrawOffer } from '@/server/commands/waitlist/offer'
import { confirmDelivery } from '@/server/commands/waitlist/delivery'
import { acceptOffer, acceptOfferOnBehalf, declineOffer } from '@/server/commands/waitlist/respond'
import { checkIn } from '@/server/commands/stays/checkIn'
import { acknowledgeCheckout, processCheckout, requestCheckout } from '@/server/commands/stays/checkout'
import { approveTransfer, recordSwapConsent, rejectTransfer } from '@/server/commands/stays/decideTransfer'
import { executeTransfer } from '@/server/commands/stays/executeTransfer'
import { requestSwap, requestTransfer } from '@/server/commands/stays/requestTransfer'
import { approveExtension, rejectExtension, requestExtension } from '@/server/commands/stays/extension'
import { cancelRequest as cancelStayRequest } from '@/server/commands/stays/cancel'
import { initiateEmergency } from '@/server/commands/emergency/initiate'
import { approveEmergency, rejectEmergency } from '@/server/commands/emergency/decide'
import { completeTask } from '@/server/commands/emergency/completeTask'
import { markLeft } from '@/server/commands/exit/markLeft'
import { completeItem, markOutstanding, reopenItem, waiveItem } from '@/server/commands/exit/items'
import { closeCase } from '@/server/commands/exit/close'
import { reactivateStaff } from '@/server/commands/exit/rehire'
import { createItem, archiveItem, updateItem } from '@/server/commands/keys/registry'
import { issueItem, returnItem, markLost, markDamaged, foundItem, retireItem, replaceItem } from '@/server/commands/keys/movements'
import { assignCleaning, cancelTask } from '@/server/commands/readiness/assign'
import { completeCleaning } from '@/server/commands/readiness/clean'
import { failInspection, passInspection } from '@/server/commands/readiness/inspect'
import { createDelegation, revokeDelegation } from '@/server/commands/approvals/delegation'
import { confirmBulkAllocation, discardBulkAllocation, previewBulkAllocation } from '@/server/commands/allocation-admin/bulk'
import { confirmBulkExit, discardBulkExit, previewBulkExit } from '@/server/commands/exit/bulk'
import * as XS from '../stays/crossHelpers'
import { attach } from '@/server/attachments'

afterAll(closeAll)

/* ---------------- the framework ---------------- */

interface Ev {
  /** The audit action. */
  a: string
  /** The entity type. */
  t: string
  /** `true`: an entity id is recorded; a string: exactly this id. */
  id?: true | string
  /** `true`: a site is recorded; a string: exactly this site; null: none. */
  site?: true | string | null
  /** A reason is recorded. */
  reason?: true
  before?: true
  after?: true
}
interface Row {
  /** The command, called with the acting context. */
  act: (rc: RequestContext) => Promise<Result<unknown>>
  /** Who does it, and who may not. */
  by: RequestContext
  refusedBy: RequestContext
  ev: Ev[]
  /** Rows that must be identical before and after a refused attempt. */
  watch?: [string, unknown[]][]
  /** A refused attempt writes this many audit rows on purpose (emergency decisions: the refusal is evidence, AT-017). */
  refusalEvents?: number
  /** The workflow also writes events after the documented ones (a cascade, a follow-up): only the leading ones are asserted exactly. */
  moreEvents?: true
  /** Audit actions that must be among the extra events (cascades). */
  includes?: string[]
  /** The documented events are written in no fixed order (one transaction per row of a bulk run). */
  unordered?: true
}

const q = async (sql: string, args: unknown[] = []) => (await admin().query(sql, args)).rows
const fresh = (rc: RequestContext): RequestContext => ({ ...rc, requestId: 'at039-' + crypto.randomUUID() })
const eventsOf = async (requestId: string) => (await admin().query<{
  action: string; actor_user_id: string | null; actor_role: string | null; entity_type: string | null; entity_id: string | null; site_id: string | null; reason: string | null; before: unknown; after: unknown
}>(`SELECT action, actor_user_id, actor_role, entity_type, entity_id, site_id, reason, before, after FROM audit_event WHERE request_id = $1 ORDER BY seq`, [requestId])).rows

/** A Resident with no role at all: every action is refused (403 or 404). */
async function nobody(): Promise<RequestContext> {
  const u = await makeUser({ roles: [{ role: 'Res' }] })
  return rcFor(u.id, { role: 'Res', sites: [], caps: [], staffId: u.staffId }, RQ.newClock())
}
const sa = async (): Promise<RequestContext> => {
  const u = await makeUser({ roles: [{ role: 'SA', all: true }] })
  return rcFor(u.id, { role: 'SA', sites: 'all', caps: [], staffId: u.staffId }, RQ.newClock())
}

type Make = () => Promise<Row>
const ROWS: [string, Make][] = []
const row = (group: string, name: string, make: Make) => ROWS.push([`${group}: ${name}`, make])


/* ---------------- property ---------------- */

const aaAt = async (siteId: string) => (await RQ.who('AA', { siteIds: [siteId] })).rc

row('property', 'create a site', async () => ({
  by: await sa(), refusedBy: await nobody(), act: rc => createSite(rc, { code: 'S' + crypto.randomUUID().slice(0, 8), name: 'Audit site', kind: 'villa', timeZone: 'UTC' }),
  ev: [{ a: 'property.site.created', t: 'site', id: true, site: true, after: true }],
}))
row('property', 'update a site', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await sa(), refusedBy: await aaAt(p.siteId), act: rc => updateSite(rc, { id: p.siteId, name: 'Renamed site' }), ev: [{ a: 'property.site.updated', t: 'site', id: p.siteId, site: p.siteId, before: true, after: true }],
    watch: [[`SELECT name FROM site WHERE id = $1`, [p.siteId]]] }
})
row('property', 'create a building', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await sa(), refusedBy: await aaAt(p.siteId), act: rc => createBuilding(rc, { siteId: p.siteId, code: 'B' + crypto.randomUUID().slice(0, 6), name: 'Block Z' }), ev: [{ a: 'property.building.created', t: 'building', id: true, site: p.siteId, after: true }] }
})
row('property', 'update a building', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await sa(), refusedBy: await aaAt(p.siteId), act: rc => updateBuilding(rc, { id: p.buildingId!, name: 'Block Renamed' }), ev: [{ a: 'property.building.updated', t: 'building', id: p.buildingId!, site: p.siteId, before: true, after: true }],
    watch: [[`SELECT name FROM building WHERE id = $1`, [p.buildingId]]] }
})
row('property', 'create a room', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  const by = await aaAt(p.siteId)
  return { by, refusedBy: await nobody(), act: rc => createRoom(rc, { siteId: p.siteId, buildingId: null, floor: null, unit: null, name: 'Room ' + crypto.randomUUID().slice(0, 5), genderPolicy: 'any', bedCodes: [] }), ev: [{ a: 'property.room.created', t: 'room', id: true, site: p.siteId, after: true }] }
})
row('property', 'update a room', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => updateRoom(rc, { id: p.roomId, name: 'Room renamed' }), ev: [{ a: 'property.room.updated', t: 'room', id: p.roomId, site: p.siteId, before: true, after: true }],
    watch: [[`SELECT name FROM room WHERE id = $1`, [p.roomId]]] }
})
row('property', 'create a bed', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => createBed(rc, { roomId: p.roomId, code: 'NB' + crypto.randomUUID().slice(0, 6) }), ev: [{ a: 'property.bed.created', t: 'bed', id: true, site: p.siteId, after: true }] }
})
row('property', 'block a bed', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => blockBed(rc, { bedId: p.bedIds[0], reason: 'Ceiling repair', until: null }), ev: [{ a: 'property.bed.blocked', t: 'bed', id: p.bedIds[0], site: p.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]]] }
})
row('property', 'unblock a bed', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  const by = await aaAt(p.siteId)
  const b = await blockBed(by, { bedId: p.bedIds[0], reason: 'Ceiling repair', until: null })
  if (!b.ok) throw new Error(b.reason)
  return { by, refusedBy: await nobody(), act: rc => unblockBed(rc, { bedId: p.bedIds[0], note: 'Repaired' }), ev: [{ a: 'property.bed.unblocked', t: 'bed', id: p.bedIds[0], site: p.siteId, before: true, after: true }],
    watch: [[`SELECT state FROM bed WHERE id = $1`, [p.bedIds[0]]]] }
})
row('property', 'archive a bed', async () => {
  const p = await ST.mkProperty({ beds: 1 })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => archiveBed(rc, { id: p.bedIds[0], reason: 'Removed from service' }), ev: [{ a: 'property.bed.archived', t: 'bed', id: p.bedIds[0], site: p.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT state, archived_at FROM bed WHERE id = $1`, [p.bedIds[0]]]] }
})
row('property', 'archive a room', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => archiveRoom(rc, { id: p.roomId, reason: 'Converted to storage', cascade: false }), ev: [{ a: 'property.room.archived', t: 'room', id: p.roomId, site: p.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT archived_at FROM room WHERE id = $1`, [p.roomId]]] }
})
row('property', 'archive a building', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  await q(`UPDATE room SET archived_at = now() WHERE id = $1`, [p.roomId])
  return { by: await sa(), refusedBy: await aaAt(p.siteId), act: rc => archiveBuilding(rc, { id: p.buildingId!, reason: 'Demolished', cascade: false }), ev: [{ a: 'property.building.archived', t: 'building', id: p.buildingId!, site: p.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT archived_at FROM building WHERE id = $1`, [p.buildingId]]] }
})

/* ---------------- staff, accounts, access, configuration ---------------- */

row('staff', 'create a staff profile', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const emp = 'E' + crypto.randomUUID().slice(0, 8)
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => createStaff(rc, { employeeId: emp, fullName: 'Audit Person', gender: 'male', department: 'Rooms', grade: 3 }), ev: [{ a: 'staff.created', t: 'staff_profile', id: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM staff_profile WHERE employee_id = $1`, [emp]]] }
})
row('staff', 'update a staff profile', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const st = await mkStaff()
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => updateStaff(rc, { id: st.id, department: 'Front office' }), ev: [{ a: 'staff.updated', t: 'staff_profile', id: st.id, before: true, after: true }],
    watch: [[`SELECT department FROM staff_profile WHERE id = $1`, [st.id]]] }
})
row('staff', 'archive a staff profile', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const st = await mkStaff()
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => archiveStaff(rc, { id: st.id, reason: 'Duplicate record' }), ev: [{ a: 'staff.archived', t: 'staff_profile', id: st.id, reason: true, before: true, after: true }],
    watch: [[`SELECT archived_at FROM staff_profile WHERE id = $1`, [st.id]]] }
})
row('access', 'create an account', async () => {
  const st = await mkStaff()
  return { by: await sa(), refusedBy: await nobody(), act: rc => createAccount(rc, { staffId: st.id, reason: 'New joiner' }), ev: [{ a: 'access.account.created', t: 'user_account', id: true, reason: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM user_account WHERE staff_id = $1`, [st.id]]] }
})
row('access', 'request a role change', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Res' }] })
  return { by: await sa(), refusedBy: await nobody(), act: rc => requestRoleChange(rc, { kind: 'add', userId: target.id, role: 'Rec', scopeKind: 'site', siteId: p.siteId, reason: 'New desk officer' }), ev: [{ a: 'access.role_change.requested', t: 'role_change_request', id: true, reason: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM role_change_request WHERE target_user_id = $1`, [target.id]]] }
})
row('access', 'approve a role change', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Res' }] })
  const maker = await sa()
  const r = await requestRoleChange(maker, { kind: 'add', userId: target.id, role: 'Rec', scopeKind: 'site', siteId: p.siteId, reason: 'New desk officer' })
  if (!r.ok) throw new Error(r.reason)
  return { by: await sa(), refusedBy: maker, act: rc => decideRoleChange(rc, { requestId: r.data.requestId, decision: 'approve', note: 'Agreed' }), ev: [{ a: 'access.role_change.approved', t: 'role_change_request', id: r.data.requestId, before: true, after: true }, { a: 'access.role.assigned', t: 'user_account', id: target.id, after: true }],
    watch: [[`SELECT status FROM role_change_request WHERE id = $1`, [r.data.requestId]], [`SELECT role FROM role_assignment WHERE user_id = $1 ORDER BY role`, [target.id]]] }
})
row('access', 'request a capability grant', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  return { by: await sa(), refusedBy: await nobody(), act: rc => requestGrant(rc, { userId: target.id, capability: 'NightKeys', reason: 'Night shift cover' }), ev: [{ a: 'access.grant.requested', t: 'capability_grant', id: true, reason: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM capability_grant WHERE user_id = $1`, [target.id]]] }
})
row('access', 'approve a capability grant', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  const maker = await sa()
  const g = await requestGrant(maker, { userId: target.id, capability: 'NightKeys', reason: 'Night shift cover' })
  if (!g.ok) throw new Error(g.reason)
  return { by: await sa(), refusedBy: maker, act: rc => decideGrant(rc, { grantId: g.data.grantId, decision: 'approve', note: 'Agreed' }), ev: [{ a: 'access.grant.approved', t: 'capability_grant', id: g.data.grantId, before: true, after: true }],
    watch: [[`SELECT status FROM capability_grant WHERE id = $1`, [g.data.grantId]]] }
})
row('access', 'revoke a capability grant', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  await grantCapability(target.id, 'NightKeys')
  const id = (await q(`SELECT id FROM capability_grant WHERE user_id = $1`, [target.id]))[0].id as string
  return { by: await sa(), refusedBy: await nobody(), act: rc => revokeGrant(rc, { grantId: id, reason: 'No longer on nights' }), ev: [{ a: 'access.grant.revoked', t: 'capability_grant', id, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM capability_grant WHERE id = $1`, [id]]] }
})
row('access', 'reset a password', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => resetPassword(rc, { userId: target.id, reason: 'Forgot it' }), ev: [{ a: 'access.account.password_reset', t: 'user_account', id: target.id, reason: true }],
    watch: [[`SELECT must_change_password, password_hash FROM user_account WHERE id = $1`, [target.id]]] }
})
row('access', 'end every session of an account', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => revokeUserSessions(rc, { userId: target.id, reason: 'Lost phone' }), ev: [{ a: 'access.account.sessions_revoked', t: 'user_account', id: target.id, reason: true }] }
})
row('access', 'deactivate an account', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  return { by: await aaAt(p.siteId), refusedBy: await nobody(), act: rc => deactivateAccount(rc, { userId: target.id, reason: 'Left the company' }), ev: [{ a: 'access.account.deactivated', t: 'user_account', id: target.id, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM user_account WHERE id = $1`, [target.id]]] }
})
row('access', 'reactivate an account', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  const target = await makeUser({ roles: [{ role: 'Rec', siteId: p.siteId }] })
  const by = await aaAt(p.siteId)
  const d = await deactivateAccount(by, { userId: target.id, reason: 'Left the company' })
  if (!d.ok) throw new Error(d.reason)
  return { by, refusedBy: await nobody(), act: rc => reactivateAccount(rc, { userId: target.id, reason: 'Back again' }), ev: [{ a: 'access.account.reactivated', t: 'user_account', id: target.id, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM user_account WHERE id = $1`, [target.id]]] }
})
row('configuration', 'save a setting (a new version)', async () => {
  const p = await ST.mkProperty({ beds: 0 })
  return { by: await sa(), refusedBy: await aaAt(p.siteId), act: rc => setConfig(rc, { key: 'calendar.weekend_days', value: [5, 6], siteId: p.siteId, reason: 'Weekend is Friday and Saturday here' }), ev: [{ a: 'config.changed', t: 'config', site: p.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM config_item WHERE key = 'calendar.weekend_days' AND scope_site_id = $1`, [p.siteId]]] }
})
row('attachments', 'attach a file to a key', async () => {
  const w = await KY.world({ beds: 1 })
  const itemId = await KY.mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
  return { by: w.rec.rc, refusedBy: await nobody(), act: rc => attach(rc, { entityType: 'handover_item', entityId: itemId, filename: 'damage.png', dataBase64: PNG.toString('base64') }), ev: [{ a: 'attachment.added', t: 'handover_item', id: itemId, site: w.siteId, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM attachment WHERE entity_id = $1`, [itemId]]] }
})

/* ---------------- requests, allocation, waitlist ---------------- */

async function oneRequest(o: { status?: string } = {}) {
  const s = await RQ.scenario({ beds: 3 })
  const bedId = s.bedIds[0]
  void o
  return { ...s, bedId }
}
row('requests', 'file a request on someone\'s behalf', async () => {
  const s = await RQ.scenario({ beds: 3 })
  const rec = await RQ.who('Rec', { siteIds: [s.siteId] })
  const person = await mkStaff()
  return { by: rec.rc, refusedBy: await nobody(), act: rc => submitRequest(rc, { staffId: person.id, siteId: s.siteId, arrivalDate: RQ.day(10), endDate: RQ.day(40), stayType: 'contract', note: null }), ev: [{ a: 'requests.request.submitted', t: 'request', id: true, site: s.siteId, after: true }] }
})
row('requests', 'approve a request (request and reservation)', async () => {
  const s = await oneRequest()
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => approveRequest(rc, { requestId: s.requestId, bedId: s.bedId }), ev: [
    { a: 'requests.request.approved', t: 'request', id: s.requestId, site: s.siteId, before: true, after: true },
    { a: 'requests.reservation.created', t: 'reservation', id: true, site: s.siteId, after: true },
  ], watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]], [`SELECT count(*)::int AS n FROM reservation WHERE request_id = $1`, [s.requestId]]] }
})
row('requests', 'reject a request', async () => {
  const s = await oneRequest()
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => rejectRequest(rc, { requestId: s.requestId, reason: 'No capacity this month' }), ev: [{ a: 'requests.request.rejected', t: 'request', id: s.requestId, site: s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]]] }
})
row('requests', 'send a request back for changes', async () => {
  const s = await oneRequest()
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => requestChanges(rc, { requestId: s.requestId, reason: 'Please give an end date' }), ev: [{ a: 'requests.request.changes_requested', t: 'request', id: s.requestId, site: s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]]] }
})
row('requests', 'edit a request that was sent back', async () => {
  const s = await oneRequest()
  const back = await requestChanges(s.aa.rc, { requestId: s.requestId, reason: 'Please give an end date' })
  if (!back.ok) throw new Error(back.reason)
  const owner = await q(`SELECT u.id, u.staff_id FROM user_account u WHERE u.staff_id = $1`, [s.person.id])
  void owner
  // the person has no login in this scenario: the officer who files for them edits
  const rec = await RQ.who('Rec', { siteIds: [s.siteId] })
  await q(`UPDATE accommodation_request SET submitted_by = $2, on_behalf = true WHERE id = $1`, [s.requestId, rec.user.id])
  return { by: rec.rc, refusedBy: await nobody(), act: rc => editRequest(rc, { requestId: s.requestId, note: 'Updated' } as never), ev: [{ a: 'requests.request.edited', t: 'request', id: s.requestId, site: s.siteId, before: true, after: true }],
    watch: [[`SELECT note, status FROM accommodation_request WHERE id = $1`, [s.requestId]]] }
})
row('requests', 'cancel a request', async () => {
  const s = await oneRequest()
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => cancelBedRequest(rc, { requestId: s.requestId, reason: 'No longer needed' }), ev: [{ a: 'requests.request.cancelled', t: 'request', id: s.requestId, site: s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]]] }
})
row('requests', 'ask for an exception', async () => {
  const s = await oneRequest()
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => requestException(rc, { requestId: s.requestId, reason: 'Needs this room', kinds: ['gender'] }), ev: [{ a: 'requests.exception.requested', t: 'request', id: s.requestId, site: s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]]] }
})
for (const verb of ['grant', 'decline'] as const) {
  row('requests', `${verb} an exception`, async () => {
    const s = await oneRequest()
    const asked = await requestException(s.aa.rc, { requestId: s.requestId, reason: 'Needs this room', kinds: ['gender'] })
    if (!asked.ok) throw new Error(asked.reason)
    const pa = await RQ.who('Mgr', { siteIds: [s.siteId], caps: ['PolicyApprover'] })
    return { by: pa.rc, refusedBy: s.aa.rc, act: rc => verb === 'grant' ? grantException(rc, { requestId: s.requestId, kinds: ['gender'], reason: 'Approved by the manager', evidence: 'memo 14 Oct' }) : declineException(rc, { requestId: s.requestId, reason: 'Not justified' }),
      ev: [{ a: verb === 'grant' ? 'requests.exception.granted' : 'requests.exception.declined', t: 'request', id: s.requestId, site: s.siteId, reason: true, before: true, after: true }],
      watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [s.requestId]], [`SELECT count(*)::int AS n FROM eligibility_exception WHERE request_id = $1`, [s.requestId]]] }
  })
}
async function reserved() {
  const s = await oneRequest()
  const other = await RQ.who('AA', { siteIds: [s.siteId] })
  const done = await approveRequest(other.rc, { requestId: s.requestId, bedId: s.bedId })
  if (!done.ok) throw new Error(done.reason)
  return { s, reservationId: done.data.reservationId }
}
row('requests', 'cancel a reservation', async () => {
  const r = await reserved()
  return { by: r.s.aa.rc, refusedBy: await nobody(), act: rc => cancelReservation(rc, { reservationId: r.reservationId, reason: 'No longer needed' }), ev: [{ a: 'requests.reservation.cancelled', t: 'reservation', id: r.reservationId, site: r.s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM reservation WHERE id = $1`, [r.reservationId]]] }
})
row('requests', 'extend the no-show deadline', async () => {
  const r = await reserved()
  return { by: r.s.aa.rc, refusedBy: await nobody(), act: rc => extendNoShow(rc, { reservationId: r.reservationId, reason: 'Flight delayed' }), ev: [{ a: 'requests.reservation.no_show_extended', t: 'reservation', id: r.reservationId, site: r.s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT no_show_extended FROM reservation WHERE id = $1`, [r.reservationId]]] }
})

async function waiting() {
  const w = await WL.world({ beds: 3 })
  const win = WL.window()
  const e = await addToWaitlist(w.rec.rc(win.clock), { staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) })
  if (!e.ok) throw new Error(e.reason)
  return { w, win, entryId: e.data.entryId }
}
row('waitlist', 'join the waitlist', async () => {
  const w = await WL.world({ beds: 3 })
  const win = WL.window()
  return { by: w.rec.rc(win.clock), refusedBy: await nobody(), act: rc => addToWaitlist(rc, { staffId: w.res.staffId, siteId: w.siteId, arrival: win.day(5), end: win.day(65) }), ev: [{ a: 'waitlist.entry.created', t: 'waitlist_entry', id: true, site: w.siteId, after: true }] }
})
row('waitlist', 'leave the waitlist', async () => {
  const t = await waiting()
  return { by: t.w.aa.rc(t.win.clock), refusedBy: await nobody(), act: rc => leaveWaitlist(rc, { entryId: t.entryId, reason: 'Found other housing' }), ev: [{ a: 'waitlist.entry.left', t: 'waitlist_entry', id: t.entryId, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM waitlist_entry WHERE id = $1`, [t.entryId]]] }
})
row('waitlist', 'renew an entry', async () => {
  const t = await waiting()
  return { by: t.w.aa.rc(t.win.clock), refusedBy: await nobody(), act: rc => renewEntry(rc, { entryId: t.entryId }), ev: [{ a: 'waitlist.entry.renewed', t: 'waitlist_entry', id: t.entryId, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT expires_at, renewals FROM waitlist_entry WHERE id = $1`, [t.entryId]]] }
})
async function offered() {
  const t = await waiting()
  const o = await createOffer(t.w.aa.rc(t.win.clock), { entryId: t.entryId, bedId: t.w.bedIds[0] })
  if (!o.ok) throw new Error(o.reason)
  return { ...t, offerId: o.data.offerId }
}
row('waitlist', 'offer a held bed', async () => {
  const t = await waiting()
  return { by: t.w.aa.rc(t.win.clock), refusedBy: await nobody(), act: rc => createOffer(rc, { entryId: t.entryId, bedId: t.w.bedIds[0] }), ev: [{ a: 'waitlist.offer.created', t: 'bed_offer', id: true, site: t.w.siteId, after: true }],
    watch: [[`SELECT status FROM waitlist_entry WHERE id = $1`, [t.entryId]]] }
})
row('waitlist', 'record that the offer was delivered', async () => {
  const t = await offered()
  return { by: t.w.rec.rc(t.win.clock), refusedBy: await nobody(), act: rc => confirmDelivery(rc, { offerId: t.offerId, via: 'offline', note: 'Told at the desk at 10:00' }), ev: [{ a: 'waitlist.offer.delivered', t: 'bed_offer', id: t.offerId, site: t.w.siteId, reason: true, after: true }],
    watch: [[`SELECT delivered_at FROM bed_offer WHERE id = $1`, [t.offerId]]] }
})
row('waitlist', 'accept an offer', async () => {
  const t = await offered()
  return { by: t.w.res.rc(t.win.clock), refusedBy: await nobody(), act: rc => acceptOffer(rc, { offerId: t.offerId }), ev: [{ a: 'waitlist.offer.accepted', t: 'bed_offer', id: t.offerId, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM bed_offer WHERE id = $1`, [t.offerId]], [`SELECT count(*)::int AS n FROM reservation WHERE staff_id = $1`, [t.w.res.staffId]]] }
})
row('waitlist', 'accept an offer on behalf of the resident', async () => {
  const t = await offered()
  return { by: t.w.rec.rc(t.win.clock), refusedBy: await nobody(), act: rc => acceptOfferOnBehalf(rc, { offerId: t.offerId, consent: 'Said yes by phone at 14:10' }), ev: [{ a: 'waitlist.offer.accepted_on_behalf', t: 'bed_offer', id: t.offerId, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM bed_offer WHERE id = $1`, [t.offerId]]] }
})
row('waitlist', 'decline an offer', async () => {
  const t = await offered()
  return { by: t.w.res.rc(t.win.clock), refusedBy: await nobody(), act: rc => declineOffer(rc, { offerId: t.offerId, reason: 'Too far' }), ev: [{ a: 'waitlist.offer.declined', t: 'bed_offer', id: t.offerId, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM bed_offer WHERE id = $1`, [t.offerId]]] }
})
row('waitlist', 'withdraw an offer', async () => {
  const t = await offered()
  return { by: t.w.aa.rc(t.win.clock), refusedBy: await nobody(), act: rc => withdrawOffer(rc, { offerId: t.offerId, reason: 'Bed needed for an emergency' }), ev: [{ a: 'waitlist.offer.withdrawn', t: 'bed_offer', id: t.offerId, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM bed_offer WHERE id = $1`, [t.offerId]]] }
})

/* ---------------- stays ---------------- */

row('stays', 'check in', async () => {
  const w = await ST.world({ beds: 3 })
  const [res] = await ST.residents(1)
  const r = await ST.mkReservation({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(0), to: ST.day(10) })
  return { by: w.rec.rc, refusedBy: await nobody(), act: rc => checkIn(rc, { reservationId: r.reservationId }), ev: [{ a: 'stays.stay.checked_in', t: 'stay', id: true, site: w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM reservation WHERE id = $1`, [r.reservationId]], [`SELECT state FROM bed WHERE id = $1`, [w.bedIds[0]]]] }
})
async function inBed() {
  const w = await ST.world({ beds: 4 })
  const [res] = await ST.residents(1)
  const s = await ST.mkStay({ bedId: w.bedIds[0], staffId: res.staffId, from: ST.day(-5), to: ST.day(30) })
  return { w, res, ...s }
}
row('stays', 'request a checkout', async () => {
  const t = await inBed()
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => requestCheckout(rc, { stayId: t.stayId, departureDate: ST.day(5), note: null }), ev: [{ a: 'stays.checkout.requested', t: 'checkout_request', id: true, site: t.w.siteId, after: true }] }
})
row('stays', 'acknowledge a checkout request', async () => {
  const t = await inBed()
  const r = await requestCheckout(t.res.rc, { stayId: t.stayId, departureDate: ST.day(5), note: null })
  if (!r.ok) throw new Error(r.reason)
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => acknowledgeCheckout(rc, { id: r.data.id }), ev: [{ a: 'stays.checkout.acknowledged', t: 'checkout_request', id: r.data.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM checkout_request WHERE id = $1`, [r.data.id]]] }
})
row('stays', 'process a checkout', async () => {
  const t = await inBed()
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => processCheckout(rc, { stayId: t.stayId, note: null }), ev: [{ a: 'stays.stay.checked_out', t: 'stay', id: t.stayId, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM stay WHERE id = $1`, [t.stayId]], [`SELECT state FROM bed WHERE id = $1`, [t.w.bedIds[0]]]] }
})
row('stays', 'cancel a transfer request', async () => {
  const t = await inBed()
  const r = await requestTransfer(t.res.rc, { stayId: t.stayId, destinationBedId: t.w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
  if (!r.ok) throw new Error(r.reason)
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => cancelStayRequest(rc, { kind: 'transfer', id: r.data.id, note: 'Changed my mind' }), ev: [{ a: 'stays.transfer.cancelled', t: 'transfer_request', id: r.data.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM transfer_request WHERE id = $1`, [r.data.id]]] }
})
row('stays', 'request a transfer', async () => {
  const t = await inBed()
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => requestTransfer(rc, { stayId: t.stayId, destinationBedId: t.w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null }), ev: [{ a: 'stays.transfer.requested', t: 'transfer_request', id: true, site: t.w.siteId, reason: true, after: true }] }
})
async function transferRequested() {
  const t = await inBed()
  const r = await requestTransfer(t.res.rc, { stayId: t.stayId, destinationBedId: t.w.bedIds[1], destinationSiteId: null, reason: 'Noisy room', neededBy: null, linkedExtensionId: null })
  if (!r.ok) throw new Error(r.reason)
  return { ...t, id: r.data.id }
}
row('stays', 'approve a transfer', async () => {
  const t = await transferRequested()
  return { by: t.w.aa.rc, refusedBy: await nobody(), act: rc => approveTransfer(rc, { id: t.id, destinationBedId: null, note: null }), ev: [{ a: 'stays.transfer.approved', t: 'transfer_request', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM transfer_request WHERE id = $1`, [t.id]]] }
})
row('stays', 'reject a transfer', async () => {
  const t = await transferRequested()
  return { by: t.w.aa.rc, refusedBy: await nobody(), act: rc => rejectTransfer(rc, { id: t.id, reason: 'Not now' }), ev: [{ a: 'stays.transfer.rejected', t: 'transfer_request', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM transfer_request WHERE id = $1`, [t.id]]] }
})
row('stays', 'carry out a transfer', async () => {
  const t = await transferRequested()
  const a = await approveTransfer(t.w.aa.rc, { id: t.id, destinationBedId: null, note: null })
  if (!a.ok) throw new Error(a.reason)
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => executeTransfer(rc, { id: t.id }), ev: [
    { a: 'stays.transfer.executed', t: 'transfer_request', id: t.id, site: t.w.siteId, before: true, after: true },
    { a: 'stays.stay.moved', t: 'stay', id: t.stayId, site: t.w.siteId, before: true, after: true },
  ], watch: [[`SELECT status FROM transfer_request WHERE id = $1`, [t.id]], [`SELECT bed_id FROM stay WHERE id = $1`, [t.stayId]]] }
})
row('stays', 'request a swap', async () => {
  const w = await ST.world({ beds: 4 })
  const [ra, rb] = await ST.residents(2)
  const a = await ST.mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: ST.day(-5), to: ST.day(30) })
  const b = await ST.mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: ST.day(-3), to: ST.day(40) })
  return { by: w.aa.rc, refusedBy: await nobody(), act: rc => requestSwap(rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'Friends want to swap', neededBy: null, consentFirst: null, consentSecond: null }), ev: [{ a: 'stays.swap.requested', t: 'transfer_request', id: true, site: w.siteId, reason: true, after: true }] }
})
row('stays', 'record a swap consent', async () => {
  const w = await ST.world({ beds: 4 })
  const [ra, rb] = await ST.residents(2)
  const a = await ST.mkStay({ bedId: w.bedIds[0], staffId: ra.staffId, from: ST.day(-5), to: ST.day(30) })
  const b = await ST.mkStay({ bedId: w.bedIds[1], staffId: rb.staffId, from: ST.day(-3), to: ST.day(40) })
  const r = await requestSwap(w.aa.rc, { stayId: a.stayId, otherStayId: b.stayId, reason: 'Friends want to swap', neededBy: null, consentFirst: null, consentSecond: null })
  if (!r.ok) throw new Error(r.reason)
  return { by: ra.rc, refusedBy: await nobody(), act: rc => recordSwapConsent(rc, { id: r.data.id, party: null, via: null, note: null }), ev: [{ a: 'stays.swap.consent', t: 'transfer_request', id: r.data.id, site: w.siteId, after: true }],
    watch: [[`SELECT consent_a_at FROM transfer_request WHERE id = $1`, [r.data.id]]] }
})
async function extensionRequested() {
  const t = await inBed()
  const r = await requestExtension(t.res.rc, { stayId: t.stayId, newEnd: ST.day(45), reason: 'Project runs on' })
  if (!r.ok) throw new Error(r.reason)
  return { ...t, id: r.data.id }
}
row('stays', 'request an extension', async () => {
  const t = await inBed()
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => requestExtension(rc, { stayId: t.stayId, newEnd: ST.day(45), reason: 'Project runs on' }), ev: [{ a: 'stays.extension.requested', t: 'extension_request', id: true, site: t.w.siteId, reason: true, after: true }] }
})
row('stays', 'approve an extension', async () => {
  const t = await extensionRequested()
  return { by: t.w.aa.rc, refusedBy: await nobody(), act: rc => approveExtension(rc, { id: t.id, note: null }), ev: [{ a: 'stays.extension.approved', t: 'extension_request', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM extension_request WHERE id = $1`, [t.id]]] }
})
row('stays', 'reject an extension', async () => {
  const t = await extensionRequested()
  return { by: t.w.aa.rc, refusedBy: await nobody(), act: rc => rejectExtension(rc, { id: t.id, reason: 'Not now' }), ev: [{ a: 'stays.extension.rejected', t: 'extension_request', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM extension_request WHERE id = $1`, [t.id]]] }
})

/* ---------------- emergency check-in ---------------- */

row('emergency', 'start an emergency check-in', async () => {
  const w = await EM.world()
  const p = await mkStaff()
  return { by: w.rec.rc(EM.clockAt(0)), refusedBy: w.aa.rc(EM.clockAt(0)), act: rc => initiateEmergency(rc, { staffId: p.id, bedId: w.bedIds[0], reason: 'Flood in block D, relocated overnight' }), ev: [{ a: 'emergency.initiated', t: 'emergency_checkin', id: true, site: w.siteId, reason: true, after: true }],
    watch: [[`SELECT count(*)::int AS n FROM emergency_checkin WHERE staff_id = $1`, [p.id]]] }
})
for (const verb of ['approve', 'reject'] as const) {
  row('emergency', `${verb} an emergency check-in`, async () => {
    const w = await EM.world()
    const e = await EM.start(w, { by: w.rec })
    return { by: w.aa.rc(EM.clockAt(1)), refusedBy: w.rec.rc(EM.clockAt(1)), act: rc => verb === 'approve' ? approveEmergency(rc, { caseId: e.caseId }) : rejectEmergency(rc, { caseId: e.caseId, reason: 'Not an emergency' }),
      ev: [{ a: verb === 'approve' ? 'emergency.approved' : 'emergency.rejected', t: 'emergency_checkin', id: e.caseId, site: w.siteId, reason: verb === 'reject' ? true : undefined, before: true, after: true }],
      watch: [[`SELECT status FROM emergency_checkin WHERE id = $1`, [e.caseId]]], refusalEvents: 1 }
  })
}
row('emergency', 'close a relocation task', async () => {
  const w = await EM.world()
  const e = await EM.start(w, { by: w.rec })
  const rej = await rejectEmergency(w.aa.rc(EM.clockAt(2)), { caseId: e.caseId, reason: 'Not an emergency' })
  if (!rej.ok) throw new Error(rej.reason)
  await EM.checkOutByHand(e.stayId)
  const taskId = rej.data.task!.id
  return { by: w.aa.rc(EM.clockAt(3)), refusedBy: w.rec.rc(EM.clockAt(3)), act: rc => completeTask(rc, { taskId, note: 'Checked out and moved' }), ev: [{ a: 'emergency.task_completed', t: 'task', id: taskId, site: w.siteId, reason: true, after: true }],
    watch: [[`SELECT done_at FROM task WHERE id = $1`, [taskId]]] }
})

/* ---------------- exit and clearance ---------------- */

async function leaver() {
  const w = await XT.world()
  const r = await XT.resident({ bedId: w.bedIds[0] })
  const left = await markLeft(w.aa.rc(), { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD })
  if (!left.ok) throw new Error(left.reason)
  const items = await XT.itemsOf(left.data.caseId)
  return { w, r, caseId: left.data.caseId, items }
}
row('exit', 'mark an employee as Left', async () => {
  const w = await XT.world()
  const r = await XT.resident({ bedId: w.bedIds[0] })
  return { by: w.aa.rc(), refusedBy: w.rec.rc(), act: rc => markLeft(rc, { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD }), ev: [{ a: 'exit.staff.marked_left', t: 'staff_profile', id: r.staffId, reason: true, before: true, after: true }],
    watch: [[`SELECT employment_status FROM staff_profile WHERE id = $1`, [r.staffId]]], moreEvents: true }
})
row('exit', 'complete a clearance item', async () => {
  const t = await leaver()
  const item = t.items.find(i => i.checklist_key === 'belongings')!.id
  return { by: t.w.rec.rc(), refusedBy: await nobody(), act: rc => completeItem(rc, { itemId: item, note: 'collected' }), ev: [{ a: 'exit.clearance.item_done', t: 'clearance_item', id: item, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM clearance_item WHERE id = $1`, [item]]] }
})
row('exit', 'mark a clearance item outstanding', async () => {
  const t = await leaver()
  const item = t.items.find(i => i.checklist_key === 'belongings')!.id
  return { by: t.w.rec.rc(), refusedBy: await nobody(), act: rc => markOutstanding(rc, { itemId: item, note: 'not yet' }), ev: [{ a: 'exit.clearance.item_outstanding', t: 'clearance_item', id: item, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM clearance_item WHERE id = $1`, [item]]] }
})
row('exit', 'reopen a clearance item', async () => {
  const t = await leaver()
  const item = t.items.find(i => i.checklist_key === 'belongings')!.id
  const d = await completeItem(t.w.rec.rc(), { itemId: item, note: 'collected' })
  if (!d.ok) throw new Error(d.reason)
  return { by: t.w.aa.rc(), refusedBy: await nobody(), act: rc => reopenItem(rc, { itemId: item, reason: 'mistake' }), ev: [{ a: 'exit.clearance.item_reopened', t: 'clearance_item', id: item, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM clearance_item WHERE id = $1`, [item]]] }
})
row('exit', 'waive a clearance item', async () => {
  const t = await leaver()
  const item = t.items.find(i => i.checklist_key === 'inspection')!.id
  return { by: t.w.pa.rc(), refusedBy: t.w.aa.rc(), act: rc => waiveItem(rc, { itemId: item, reason: 'Room being refurbished', evidence: 'Works order W-12', confirmPassword: PASSWORD }), ev: [{ a: 'exit.clearance.item_waived', t: 'clearance_item', id: item, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM clearance_item WHERE id = $1`, [item]]] }
})
row('exit', 'close a clearance case', async () => {
  const t = await leaver()
  for (const i of t.items) {
    if (!i.mandatory) continue
    const rc = i.owner === 'Maintenance' ? t.w.mc.rc() : i.owner === 'AA' ? t.w.aa.rc() : t.w.rec.rc()
    if (i.checklist_key === 'inspection') { const w = await waiveItem(t.w.pa.rc(), { itemId: i.id, reason: 'Room being refurbished', evidence: 'Works order W-12', confirmPassword: PASSWORD }); if (!w.ok) throw new Error(w.reason); continue }
    const d = await completeItem(rc, { itemId: i.id, note: 'done' })
    if (!d.ok && d.code !== 'conflict') throw new Error(d.reason)
  }
  const out = await XT.world()
  void out
  return { by: t.w.aa.rc(), refusedBy: await nobody(), act: rc => closeCase(rc, { caseId: t.caseId }), ev: [{ a: 'exit.clearance.cleared', t: 'clearance_case', id: t.caseId, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM clearance_case WHERE id = $1`, [t.caseId]]], moreEvents: true }
})
row('exit', 'rehire a former employee', async () => {
  const w = await XT.world()
  const r = await mkStaff({ status: 'left' })
  return { by: w.aa.rc(), refusedBy: w.rec.rc(), act: rc => reactivateStaff(rc, { staffId: r.id, reason: 'Back on the payroll', confirmPassword: PASSWORD }), ev: [{ a: 'exit.staff.rehired', t: 'staff_profile', id: r.id, reason: true, before: true, after: true }],
    watch: [[`SELECT employment_status FROM staff_profile WHERE id = $1`, [r.id]]] }
})

/* ---------------- keys ---------------- */

row('keys', 'add a key to the cabinet', async () => {
  const w = await KY.world({ beds: 1 })
  return { by: w.aa.rc, refusedBy: w.rec.rc, act: rc => createItem(rc, { siteId: w.siteId, category: 'key', itemType: 'room_key', code: 'K-' + crypto.randomUUID().slice(0, 6), roomId: null, bedId: w.bedIds[0], note: null }), ev: [{ a: 'keys.item.created', t: 'handover_item', id: true, site: w.siteId, after: true }] }
})
row('keys', 'edit a key', async () => {
  const w = await KY.world({ beds: 1 })
  const id = await KY.mkItem({ siteId: w.siteId, bedId: w.bedIds[0] })
  return { by: w.aa.rc, refusedBy: w.rec.rc, act: rc => updateItem(rc, { id, note: 'Spare for the corner room' }), ev: [{ a: 'keys.item.updated', t: 'handover_item', id, site: w.siteId, before: true, after: true }],
    watch: [[`SELECT note FROM handover_item WHERE id = $1`, [id]]] }
})
async function keyInBed(status: 'in_cabinet' | 'issued' | 'lost' | 'damaged') {
  const w = await KY.world({ beds: 2 })
  const res = await KY.resident(w.bedIds[0])
  const id = await KY.mkItem({ siteId: w.siteId, bedId: w.bedIds[0], holderStaffId: status === 'in_cabinet' ? undefined : res.staffId, status })
  return { w, res, id }
}
row('keys', 'issue a key', async () => {
  const t = await keyInBed('in_cabinet')
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => issueItem(rc, { itemId: t.id, staffId: t.res.staffId, dueBack: null, note: null }), ev: [{ a: 'keys.item.issued', t: 'handover_item', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status, holder_staff_id FROM handover_item WHERE id = $1`, [t.id]]] }
})
row('keys', 'take a key back', async () => {
  const t = await keyInBed('issued')
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => returnItem(rc, { itemId: t.id, onBehalf: undefined, note: null }), ev: [{ a: 'keys.item.returned', t: 'handover_item', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status, holder_staff_id FROM handover_item WHERE id = $1`, [t.id]]] }
})
for (const verb of ['lost', 'damaged'] as const) {
  row('keys', `record a key as ${verb}`, async () => {
    const t = await keyInBed('issued')
    return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => (verb === 'lost' ? markLost : markDamaged)(rc, { itemId: t.id, note: 'Reported at the desk', attachmentIds: undefined }), ev: [{ a: `keys.item.${verb}`, t: 'handover_item', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
      watch: [[`SELECT status FROM handover_item WHERE id = $1`, [t.id]]] }
  })
}
row('keys', 'record that a lost key was found', async () => {
  const t = await keyInBed('lost')
  return { by: t.w.rec.rc, refusedBy: await nobody(), act: rc => foundItem(rc, { itemId: t.id, to: 'cabinet', note: null }), ev: [{ a: 'keys.item.found', t: 'handover_item', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM handover_item WHERE id = $1`, [t.id]]] }
})
row('keys', 'replace a lost key', async () => {
  const t = await keyInBed('lost')
  return { by: t.w.aa.rc, refusedBy: t.w.rec.rc, act: rc => replaceItem(rc, { itemId: t.id, newCode: 'K-R-' + crypto.randomUUID().slice(0, 5), note: null }), ev: [{ a: 'keys.item.created', t: 'handover_item', id: true, site: t.w.siteId, reason: true, after: true }, { a: 'keys.item.replaced', t: 'handover_item', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status, replaced_by FROM handover_item WHERE id = $1`, [t.id]]], moreEvents: true }
})
row('keys', 'retire a lost key', async () => {
  const t = await keyInBed('lost')
  return { by: t.w.aa.rc, refusedBy: t.w.rec.rc, act: rc => retireItem(rc, { itemId: t.id, reason: 'Written off' }), ev: [{ a: 'keys.item.retired', t: 'handover_item', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM handover_item WHERE id = $1`, [t.id]]] }
})
row('keys', 'archive a key', async () => {
  const t = await keyInBed('in_cabinet')
  return { by: t.w.aa.rc, refusedBy: t.w.rec.rc, act: rc => archiveItem(rc, { id: t.id, reason: 'Lock changed' }), ev: [{ a: 'keys.item.archived', t: 'handover_item', id: t.id, site: t.w.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT archived_at FROM handover_item WHERE id = $1`, [t.id]]] }
})

/* ---------------- housekeeping and inspection ---------------- */

async function vacated() {
  const s = await RD.scene({ beds: 3 })
  const v = await RD.vacate(s, s.bedIds[0])
  return { s, v }
}
row('readiness', 'assign a cleaning task', async () => {
  const t = await vacated()
  return { by: t.s.rec.rc, refusedBy: await nobody(), act: rc => assignCleaning(rc, { taskId: t.v.taskId, housekeeperStaffId: t.s.hk.staffId, note: null }), ev: [{ a: 'readiness.cleaning.assigned', t: 'cleaning_task', id: t.v.taskId, site: t.s.siteId, before: true, after: true }],
    watch: [[`SELECT assigned_to_staff FROM cleaning_task WHERE id = $1`, [t.v.taskId]]] }
})
row('readiness', 'cancel a cleaning task', async () => {
  const t = await vacated()
  // the bed goes out of use (blocked), so the task no longer matches it
  const blocker = await RQ.who('AA', { siteIds: [t.s.siteId] })
  const blocked = await blockBed(blocker.rc, { bedId: t.s.bedIds[0], reason: 'Ceiling repair', until: null })
  if (!blocked.ok) throw new Error(blocked.reason)
  return { by: t.s.rec.rc, refusedBy: await nobody(), act: rc => cancelTask(rc, { taskId: t.v.taskId, reason: 'Resident moved back in' }), ev: [{ a: 'readiness.cleaning.cancelled', t: 'cleaning_task', id: t.v.taskId, site: t.s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM cleaning_task WHERE id = $1`, [t.v.taskId]]] }
})
async function cleaned() {
  const t = await vacated()
  await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, t.s.hk.staffId])
  const c = await completeCleaning(t.s.hk.rc, { taskId: t.v.taskId, checklist: RD.FULL, notes: null })
  if (!c.ok) throw new Error(c.reason)
  return t
}
row('readiness', 'complete a cleaning', async () => {
  const t = await vacated()
  await q(`UPDATE cleaning_task SET assigned_to_staff = $2 WHERE id = $1`, [t.v.taskId, t.s.hk.staffId])
  return { by: t.s.hk.rc, refusedBy: await nobody(), act: rc => completeCleaning(rc, { taskId: t.v.taskId, checklist: RD.FULL, notes: null }), ev: [{ a: 'readiness.cleaning.completed', t: 'cleaning_task', id: t.v.taskId, site: t.s.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM cleaning_task WHERE id = $1`, [t.v.taskId]], [`SELECT state FROM bed WHERE id = $1`, [t.s.bedIds[0]]]] }
})
row('readiness', 'pass a final inspection (the bed becomes Available)', async () => {
  const t = await cleaned()
  return { by: t.s.insp.rc, refusedBy: await nobody(), act: rc => passInspection(rc, { taskId: t.v.taskId, note: null }), ev: [{ a: 'readiness.inspection.passed', t: 'cleaning_task', id: t.v.taskId, site: t.s.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM cleaning_task WHERE id = $1`, [t.v.taskId]], [`SELECT state FROM bed WHERE id = $1`, [t.s.bedIds[0]]]] }
})
row('readiness', 'fail a final inspection', async () => {
  const t = await cleaned()
  return { by: t.s.insp.rc, refusedBy: await nobody(), act: rc => failInspection(rc, { taskId: t.v.taskId, note: 'Bathroom not clean' }), ev: [{ a: 'readiness.inspection.failed', t: 'cleaning_task', id: t.v.taskId, site: t.s.siteId, reason: true, before: true, after: true }],
    watch: [[`SELECT status FROM cleaning_task WHERE id = $1`, [t.v.taskId]]] }
})

/* ---------------- delegation ---------------- */

row('approvals', 'name a stand-in', async () => {
  const w = await WL.world({ beds: 0 })
  const win = WL.window()
  const approver = await WL.person('AA', { siteIds: [w.siteId] })
  const standIn = await WL.person('AA', { siteIds: [w.siteId] })
  return { by: approver.rc(win.clock), refusedBy: await nobody(), act: rc => createDelegation(rc, { toUserId: standIn.user.id, startsOn: win.day(1), endsOn: win.day(5), reason: 'Leave' } as never), ev: [{ a: 'approvals.delegation.created', t: 'delegation', id: true, reason: true, after: true }] }
})
row('approvals', 'end a delegation', async () => {
  const w = await WL.world({ beds: 0 })
  const win = WL.window()
  const approver = await WL.person('AA', { siteIds: [w.siteId] })
  const standIn = await WL.person('AA', { siteIds: [w.siteId] })
  const d = await createDelegation(approver.rc(win.clock), { toUserId: standIn.user.id, startsOn: win.day(1), endsOn: win.day(5), reason: 'Leave' } as never)
  if (!d.ok) throw new Error(d.reason)
  return { by: approver.rc(win.clock), refusedBy: await nobody(), act: rc => revokeDelegation(rc, { delegationId: d.data.delegationId }), ev: [{ a: 'approvals.delegation.revoked', t: 'delegation', id: d.data.delegationId, before: true, after: true }],
    watch: [[`SELECT revoked_at FROM delegation WHERE id = $1`, [d.data.delegationId]]] }
})


/* ---------------- bulk runs, cancellations, cross-site follow-ups, cascades ---------------- */

async function bulkPreview() {
  const s = await RQ.scenario({ beds: 3 })
  const aa = await RQ.who('AA', { siteIds: [s.siteId] })
  const p = await previewBulkAllocation(aa.rc, { siteId: s.siteId, requestIds: [s.requestId] })
  if (!p.ok) throw new Error(p.reason)
  return { s, aa, batchId: p.data.batchId }
}
row('requests', 'preview a bulk allocation', async () => {
  const s = await RQ.scenario({ beds: 3 })
  return { by: s.aa.rc, refusedBy: await nobody(), act: rc => previewBulkAllocation(rc, { siteId: s.siteId, requestIds: [s.requestId] }), ev: [{ a: 'requests.bulk.previewed', t: 'bulk_allocation', id: true, site: s.siteId, after: true }] }
})
row('requests', 'confirm a bulk allocation (each row is an approval)', async () => {
  const t = await bulkPreview()
  return { by: t.aa.rc, refusedBy: await nobody(), act: rc => confirmBulkAllocation(rc, { batchId: t.batchId }), unordered: true,
    ev: [{ a: 'requests.request.approved', t: 'request', id: t.s.requestId, site: t.s.siteId, before: true, after: true }, { a: 'requests.reservation.created', t: 'reservation', id: true, site: t.s.siteId, after: true }, { a: 'requests.bulk.confirmed', t: 'bulk_allocation', id: t.batchId, site: t.s.siteId, after: true }],
    watch: [[`SELECT status FROM accommodation_request WHERE id = $1`, [t.s.requestId]]] }
})
row('requests', 'discard a bulk allocation preview', async () => {
  const t = await bulkPreview()
  return { by: t.aa.rc, refusedBy: await nobody(), act: rc => discardBulkAllocation(rc, { batchId: t.batchId }), ev: [{ a: 'requests.bulk.discarded', t: 'bulk_allocation', id: t.batchId, site: t.s.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM bulk_allocation_batch WHERE id = $1`, [t.batchId]]] }
})
async function exitPreview() {
  const w = await XT.world()
  const r = await XT.resident({ bedId: w.bedIds[0] })
  const p = await previewBulkExit(w.aa.rc(), { employeeIds: [r.employeeId], effectiveDate: '2026-10-14', reason: 'Restructure' } as never)
  if (!p.ok) throw new Error(p.reason)
  return { w, r, batchId: p.data.batchId }
}
row('exit', 'preview a bulk Mark as Left', async () => {
  const w = await XT.world()
  const r = await XT.resident({ bedId: w.bedIds[0] })
  return { by: w.aa.rc(), refusedBy: await nobody(), act: rc => previewBulkExit(rc, { employeeIds: [r.employeeId], effectiveDate: '2026-10-14', reason: 'Restructure' } as never), ev: [{ a: 'exit.bulk.previewed', t: 'exit_bulk', id: true, reason: true, after: true }] }
})
row('exit', 'confirm a bulk Mark as Left (each row is a Mark as Left)', async () => {
  const t = await exitPreview()
  return { by: t.w.aa.rc(), refusedBy: await nobody(), act: rc => confirmBulkExit(rc, { batchId: t.batchId, confirmPassword: PASSWORD }), unordered: true, moreEvents: true,
    ev: [{ a: 'exit.staff.marked_left', t: 'staff_profile', id: t.r.staffId, reason: true, before: true, after: true }, { a: 'exit.bulk.confirmed', t: 'exit_bulk', id: t.batchId, after: true }],
    watch: [[`SELECT employment_status FROM staff_profile WHERE id = $1`, [t.r.staffId]]] }
})
row('exit', 'discard a bulk Mark as Left preview', async () => {
  const t = await exitPreview()
  return { by: t.w.aa.rc(), refusedBy: await nobody(), act: rc => discardBulkExit(rc, { batchId: t.batchId }), ev: [{ a: 'exit.bulk.discarded', t: 'exit_bulk', id: t.batchId, before: true, after: true }],
    watch: [[`SELECT status FROM exit_bulk_batch WHERE id = $1`, [t.batchId]]] }
})
row('exit', 'mark as Left closes the waitlist entry (cascade)', async () => {
  const w = await XT.world()
  const r = await XT.resident()
  await q(`INSERT INTO waitlist_entry (staff_id, site_id, expires_at, arrival_date, stay_type, status) VALUES ($1, $2, '2099-01-01', '2026-11-01', 'contract', 'waiting')`, [r.staffId, w.siteId])
  return { by: w.aa.rc(), refusedBy: w.rec.rc(), act: rc => markLeft(rc, { staffId: r.staffId, effectiveDate: '2026-10-14', reason: 'Resigned', confirmPassword: PASSWORD }), moreEvents: true, includes: ['waitlist.entry.closed'],
    ev: [{ a: 'exit.staff.marked_left', t: 'staff_profile', id: r.staffId, reason: true, before: true, after: true }],
    watch: [[`SELECT employment_status FROM staff_profile WHERE id = $1`, [r.staffId]], [`SELECT status FROM waitlist_entry WHERE staff_id = $1`, [r.staffId]]] }
})
row('stays', 'cancel a checkout request', async () => {
  const t = await inBed()
  const r = await requestCheckout(t.res.rc, { stayId: t.stayId, departureDate: ST.day(5), note: null })
  if (!r.ok) throw new Error(r.reason)
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => cancelStayRequest(rc, { kind: 'checkout', id: r.data.id, note: 'Staying on' }), ev: [{ a: 'stays.checkout.cancelled', t: 'checkout_request', id: r.data.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM checkout_request WHERE id = $1`, [r.data.id]]] }
})
row('stays', 'cancel an extension request', async () => {
  const t = await extensionRequested()
  return { by: t.res.rc, refusedBy: await nobody(), act: rc => cancelStayRequest(rc, { kind: 'extension', id: t.id, note: 'Not needed' }), ev: [{ a: 'stays.extension.cancelled', t: 'extension_request', id: t.id, site: t.w.siteId, before: true, after: true }],
    watch: [[`SELECT status FROM extension_request WHERE id = $1`, [t.id]]] }
})
row('stays', 'request a swap across two sites (one event for each site)', async () => {
  const sc = await XS.twoStays()
  const c = { via: 'in_person' as const, note: null }
  return { by: sc.src.aa.rc, refusedBy: await nobody(), act: rc => requestSwap(rc, { stayId: sc.a.stayId, otherStayId: sc.b.stayId, reason: 'Friends want to swap sites', neededBy: null, consentFirst: c, consentSecond: c }),
    ev: [{ a: 'stays.swap.requested', t: 'transfer_request', id: true, site: sc.src.siteId, reason: true, after: true }, { a: 'stays.swap.requested_cross_site', t: 'transfer_request', id: true, site: sc.dst.siteId, reason: true, after: true }] }
})
row('stays', 'carry out a cross-site move: the open checkout request follows the resident', async () => {
  const sc = await XS.cross()
  const out = await requestCheckout(sc.res.rc, { stayId: sc.stayId, departureDate: ST.day(20), note: null })
  if (!out.ok) throw new Error(out.reason)
  const id = await XS.requested(sc)
  await XS.approvedByBoth(sc, id, sc.dst.bedIds[1])
  return { by: sc.src.rec.rc, refusedBy: await nobody(), act: rc => executeTransfer(rc, { id }), moreEvents: true, includes: ['stays.checkout_request.rerouted', 'stays.stay.left_site'],
    ev: [{ a: 'stays.transfer.executed', t: 'transfer_request', id, before: true, after: true }],
    watch: [[`SELECT status FROM transfer_request WHERE id = $1`, [id]], [`SELECT site_id FROM checkout_request WHERE id = $1`, [out.data.id]]] }
})

/* ---------------- sign-in: mode switch and password change ---------------- */

describe('AT-039 sign-in events', () => {
  it('switching mode and changing the password each write one audit event with the actor and role', async () => {
    const { call, signIn } = await import('../harness')
    const p = await ST.mkProperty({ beds: 0 })
    const u = await makeUser({ roles: [{ role: 'AA', siteId: p.siteId }, { role: 'Rec', siteId: p.siteId }] })
    const cookie = await signIn(u)
    const { POST: switchRoute } = await import('../../../app/api/v1/auth/switch-role/route')
    const { POST: changeRoute } = await import('../../../app/api/v1/auth/change-password/route')
    const sw = await call(switchRoute, { body: { role: 'Rec' }, cookie })
    expect(sw.status).toBe(200)
    let ev = await eventsOf(sw.body.requestId)
    expect(ev.map(e => e.action)).toEqual(['auth.mode_switched'])
    expect(ev[0]).toMatchObject({ actor_user_id: u.id, entity_type: 'session' })
    expect(ev[0].before).not.toBeNull(); expect(ev[0].after).not.toBeNull()
    const refused = await call(switchRoute, { body: { role: 'SA' }, cookie })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(await eventsOf(refused.body.requestId)).toEqual([])
    const ch = await call(changeRoute, { body: { current: u.password, next: 'A-brand-new-Password-42!' }, cookie })
    expect(ch.status, JSON.stringify(ch.body)).toBe(200)
    ev = await eventsOf(ch.body.requestId)
    expect(ev.map(e => e.action)).toEqual(['auth.password_changed'])
    expect(ev[0]).toMatchObject({ actor_user_id: u.id, entity_type: 'user_account', entity_id: u.id })
    const wrong = await call(changeRoute, { body: { current: 'not-my-password-1', next: 'Another-Password-43!' }, cookie: await signIn({ username: u.username, password: 'A-brand-new-Password-42!' }) })
    expect(wrong.status).toBeGreaterThanOrEqual(400)
    expect((await eventsOf(wrong.body.requestId)).map(e => e.action)).not.toContain('auth.password_changed')
  })
})

/* ---------------- the tests ---------------- */

describe('AT-039 every mutating workflow writes exactly the documented audit events', () => {
  it.each(ROWS)('%s', async (_name, make) => {
    const r = await make()
    const rc = fresh(r.by)
    const result = await r.act(rc)
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.reason}`).toBe(true)
    const events = await eventsOf(rc.requestId)
    const observed = events.map(e => `${e.action}/${e.entity_type}`)
    const documented = r.ev.map(e => `${e.a}/${e.t}`)
    if (r.unordered) {
      for (const d of documented) expect(observed, `${d} is written`).toContain(d)
      if (!r.moreEvents) expect([...observed].sort(), 'exactly the documented events').toEqual([...documented].sort())
    } else if (!r.moreEvents) expect(observed, 'exactly the documented events').toEqual(documented)
    else for (const d of documented) expect(observed, `${d} is written (with the cascade that belongs to it)`).toContain(d)
    for (const a of r.includes ?? []) expect(events.map(e => e.action), `${a} is written by the cascade`).toContain(a)
    for (const want of r.ev) {
      const got = events.find(e => `${e.action}/${e.entity_type}` === `${want.a}/${want.t}`)!
      const label = `${want.a}`
      expect(got.actor_user_id, `${label}: actor`).toBe(rc.user.id)
      expect(got.actor_role, `${label}: role`).toBe(rc.actor.role)
      if (want.id === true) expect(got.entity_id, `${label}: entity id`).toBeTruthy()
      else if (want.id) expect(got.entity_id, `${label}: entity id`).toBe(want.id)
      if (want.site === true) expect(got.site_id, `${label}: site`).toBeTruthy()
      else if (typeof want.site === 'string') expect(got.site_id, `${label}: site`).toBe(want.site)
      else if (want.site === null) expect(got.site_id, `${label}: no site`).toBeNull()
      if (want.reason) expect((got.reason ?? '').trim().length, `${label}: reason`).toBeGreaterThan(0)
      if (want.before) expect(got.before, `${label}: before`).not.toBeNull()
      if (want.after) expect(got.after, `${label}: after`).not.toBeNull()
    }
  })

  it.each(ROWS)('%s: a refused command leaves no audit row and changes nothing', async (_name, make) => {
    const r = await make()
    const watch = async () => JSON.stringify(await Promise.all((r.watch ?? []).map(([sql, args]) => q(sql, args))))
    const before = await watch()
    const rc = fresh(r.refusedBy)
    const result = await r.act(rc)
    expect(result.ok, 'a person who may not do this is refused').toBe(false)
    const events = await eventsOf(rc.requestId)
    // The one deliberate exception: a refused emergency decision is itself evidence (AT-017) and is written outside the rolled-back command.
    const allowed = r.refusalEvents ? ['emergency.decision_refused'] : []
    expect(events.map(e => e.action).filter(a => !allowed.includes(a)), 'no audit row from a refused command').toEqual([])
    expect(await watch(), 'nothing changed').toBe(before)
  })
})

/* ---------------- every audit action is asserted somewhere ---------------- */

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}
const ROOT = path.resolve(__dirname, '../../..')

describe('AT-039 no audit action goes unasserted', () => {
  it('every audit action written by the code appears in at least one test', () => {
    const literals = new Set<string>()
    for (const f of walk(path.join(ROOT, 'src/server'))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(?:action|AUDIT_ACTION):\s*'([a-z_]+(?:\.[a-z_]+){1,3})'/g)) literals.add(m[1])
    }
    // not audit actions: policy action names used as data (the approvals inbox deciders)
    const policyNames = /^(approvals_inbox|requests_waitlist|reservations_stays|transfers_swaps|emergency_checkin|exit_clearance|keys|housekeeping_readiness|users_roles|rooms_beds|sites_buildings|staff_directory|checkin_checkout|maintenance|visitors_gate|incidents_sos|reports_exports|audit_log|system_config|migration_import)\./
    const tests = walk(path.join(ROOT, 'tests')).map(f => readFileSync(f, 'utf8')).join('\n')
    const missing = [...literals].filter(a => !policyNames.test(a)).filter(a => !tests.includes(`'${a}'`) && !tests.includes(`"${a}"`) && !tests.includes(`\`${a}\``)).sort()
    expect(missing, 'audit actions that no test asserts').toEqual([])
  })
})

/* ---------------- the audit log is append-only ---------------- */

describe('AT-039 the audit log cannot be edited or deleted', () => {
  it('no route under app/api edits, deletes or writes audit rows; the audit route only reads', () => {
    const offenders: string[] = []
    for (const f of walk(path.join(ROOT, 'app/api'))) {
      if (!f.endsWith('route.ts')) continue
      const src = readFileSync(f, 'utf8')
      const rel = path.relative(ROOT, f)
      const touchesAudit = /audit_event|auditEvent|audit_log|\/audit\b/.test(src) || /\/audit\//.test(rel)
      if (!touchesAudit) continue
      if (/export const (POST|PUT|PATCH|DELETE)\b/.test(src)) offenders.push(`${rel}: exports a mutating method on an audit path`)
      if (/\.(update|delete)\(\s*auditEvent|\bUPDATE\s+audit_event|\bDELETE\s+FROM\s+audit_event|TRUNCATE\s+audit_event/i.test(src)) offenders.push(`${rel}: changes audit rows`)
    }
    expect(offenders).toEqual([])
  })

  it('no source file outside the audit writers updates or deletes audit_event', () => {
    const offenders: string[] = []
    for (const f of walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'app')))) {
      const src = readFileSync(f, 'utf8')
      if (/\.(update|delete)\(\s*auditEvent\s*\)/.test(src) || /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+audit_event\b/i.test(src)) offenders.push(path.relative(ROOT, f))
    }
    expect(offenders).toEqual([])
  })

  it('the application login is refused UPDATE, DELETE and TRUNCATE on audit_event, and can only INSERT and SELECT', async () => {
    const pool = getPool()
    for (const sql of [`UPDATE audit_event SET reason = 'edited' WHERE false`, `DELETE FROM audit_event WHERE false`, `TRUNCATE audit_event`]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/permission denied/i)
    }
    const priv = (await pool.query<{ p: string; ok: boolean }>(
      `SELECT p, has_table_privilege(current_user, 'audit_event', p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p`)).rows
    expect(Object.fromEntries(priv.map(r => [r.p, r.ok]))).toMatchObject({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false })
    void getDb
  })

  it('even the table owner cannot rewrite history: a trigger refuses UPDATE and DELETE', async () => {
    const id = (await admin().query<{ id: string }>(`INSERT INTO audit_event (action, actor_role) VALUES ('test.append_only', 'system') RETURNING id`)).rows[0].id
    await expect(admin().query(`UPDATE audit_event SET reason = 'x' WHERE id = $1`, [id])).rejects.toThrow()
    await expect(admin().query(`DELETE FROM audit_event WHERE id = $1`, [id])).rejects.toThrow()
  })
})
