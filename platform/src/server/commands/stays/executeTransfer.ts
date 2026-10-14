/**
 * Execute an approved transfer or swap (D-61, D-62, D-104, AT-022).
 *
 * ONE transaction. Both beds (and the stay rows) are locked in id order before anything is read, so two moves into the
 * same bed queue up and the second sees what the first did. A transfer ALLOCATES THE DESTINATION FIRST (allocateBed,
 * kind stay, the bed must be ready) and only when that has passed does it release the source claim, move the stay,
 * mark the destination Occupied and the source Needs cleaning. A swap releases both claims and allocates both new ones
 * (two occupied beds cannot be allocated while their owners still hold them); every step is in the same transaction, so
 * any refusal rolls ALL of it back and both residents stay exactly where they were.
 *
 * Across sites (D-104) nothing about that changes, except that the destination is judged AT THE DESTINATION SITE: allocateBed
 * checks the eligibility rules (gender, grade) of the destination room and site and the readiness of the bed, "today" is the
 * destination site's today, and the destination site must be live. The stay's site is derived from its bed, so once the move
 * commits every query, scope check and audit row uses the new site. The follow-ups for everything else the person holds
 * (crossSite.ts: SRS 5.5 step 27) run inside the same transaction. Who may execute (DEFAULT, D-104): Reception or an Accommodation
 * Admin with scope on EITHER site, after BOTH approvals (the database refuses an approved request with a key missing).
 *
 * When the move cannot be completed the transaction rolls back, and AFTERWARDS a small separate transaction marks the
 * request `failed` with the reason (that record, its audit row and the alert to the Accommodation Admins survive), because
 * "approved" would otherwise look like "still going to happen". The failure clears the destination key (a swap: both keys),
 * so the admins decide again. Keys: the return and reissue are Stage 3 (WP-I); the audit row carries a placeholder.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { bed, auditEvent, stay } from '@/server/db/schema'
import { transferRequest } from '@/server/db/schema.stays'
import { getDb } from '@/server/db/client'
import { audit } from '@/server/audit'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, ok, type Failure, type Result } from '@/server/command/result'
import { allocateBed, overlappingClaims, releaseClaim, suggestBeds } from '@/server/allocation'
import { recordExceptionUse } from '@/server/eligibility'
import { notify } from '@/server/notify'
import { authorizeAny, bedLabel, idSchema, KEYS_PLACEHOLDER, loadStaysLocked, lockBeds, notInvolved, siteToday, staffName, type StayFull } from './shared'
import {
  checkDestinationSite, executionFailed, guarded, isCrossSite, isExecutionFailure, loadTransfer, siteNameOf, waitingForApproval, type TransferRow,
} from './transferShared'
import { runCrossSiteFollowUps } from './crossSite'
import { openCleaningTask } from '@/server/readiness/hooks'

export const input = z.object({ id: idSchema })
export type ExecuteTransferInput = z.infer<typeof input>
export interface ExecuteTransferOut { id: string; kind: 'transfer' | 'swap'; status: 'executed'; moves: { stayId: string; fromBed: string; toBed: string }[] }

export async function executeTransfer(rc: RequestContext, i: ExecuteTransferInput): Promise<Result<ExecuteTransferOut>> {
  const r = await runCommand(rc, c => run(c, i.id))
  if (!r.ok && isExecutionFailure(r)) await recordFailure(rc, i.id, r)
  return r
}

const maxStr = (a: string, b: string) => (a > b ? a : b)

/** Reception or an Accommodation Admin with scope on the source OR the destination site (the DEFAULT of D-104). */
function authorizeExecutor(c: CommandContext, t: TransferRow): Failure | undefined {
  const src = authorizeAny(c, ['transfers_swaps.execute'], { siteId: t.siteId })
  if (!src || !isCrossSite(t)) return src
  const dst = authorizeAny(c, ['transfers_swaps.execute'], { siteId: t.destinationSiteId })
  if (!dst) return undefined
  return src.code === 'not_found' ? dst : src
}

async function run(c: CommandContext, id: string): Promise<Result<ExecuteTransferOut>> {
  const t = await loadTransfer(c.tx, id, true)
  if (!t) return fail.notFound()
  const denied = authorizeExecutor(c, t)
  if (denied) return denied
  const self = notInvolved(c, [t.staffId, t.otherStaffId], `carry out this ${t.kind}`)
  if (self) return self
  if (t.status !== 'approved') {
    const waiting = await waitingForApproval(c.tx, t)
    const named = waiting && waiting.sites.length > 0
    const why: Record<string, [string, string, string]> = {
      requested: [`is still waiting for approval${named ? ` from ${waiting.text}` : ''}`, waiting?.owner ?? 'Accommodation Admin', named ? `Ask ${waiting.text} to approve it; it is carried out only after both sites have approved` : 'Ask the Accommodation Admin to approve it'],
      failed: ['failed the last time it was tried; nothing moved', waiting?.owner ?? 'Accommodation Admin', named ? `${waiting.text} chooses another destination and approves again` : 'The Accommodation Admin chooses another destination and approves again'],
      executed: ['has already been carried out', 'Reception', 'Nothing more to do'],
      rejected: ['was rejected', 'Accommodation Admin', 'Raise a new request if it is still wanted'],
      cancelled: ['was cancelled', 'Accommodation Admin', 'Raise a new request if it is still wanted'],
    }
    const [what, owner, next] = why[t.status] ?? ['cannot be carried out', 'Accommodation Admin', 'Check its status']
    return fail.conflict(`This ${t.kind} ${what}`, owner, next, { reason: `transfer_${t.status}` })
  }
  return t.kind === 'swap' ? runSwap(c, t) : runTransfer(c, t)
}

/** Loads and checks the stay(s) are still where the request said; the stays are locked in id order. */
async function lockStays(c: CommandContext, t: TransferRow): Promise<{ a: StayFull; b?: StayFull } | Failure> {
  const stays = await loadStaysLocked(c.tx, [t.stayId, ...(t.otherStayId ? [t.otherStayId] : [])])
  const a = stays.find(x => x.id === t.stayId)
  const b = stays.find(x => x.id === t.otherStayId)
  const stale = (what: string) => executionFailed(fail.conflict(`${what}; the ${t.kind} was approved for a situation that no longer exists`, 'Accommodation Admin', 'Cancel it and raise a new request if it is still wanted', { reason: 'stale' }))
  if (!a || a.status !== 'active') return stale('The stay is no longer active')
  if (a.bedId !== t.fromBedId) return stale('The resident has already moved to another bed')
  if (t.kind === 'swap') {
    if (!b || b.status !== 'active') return stale('The other stay is no longer active')
    if (b.bedId !== t.toBedId) return stale('The other resident has already moved to another bed')
  }
  return { a, b }
}

function newPeriod(s: StayFull, today: string): { from: string; to?: string } | Failure {
  const from = maxStr(today, s.from)
  if (s.to !== null && s.to <= from) {
    return executionFailed(fail.conflict('The stay has already reached its end date, so there is nothing left to move', 'Accommodation Admin', 'Extend the stay first, or process the checkout', { reason: 'stay_ended', stayId: s.id }))
  }
  return { from, to: s.to ?? undefined }
}

/* ---------------- transfer ---------------- */

async function runTransfer(c: CommandContext, t: TransferRow): Promise<Result<ExecuteTransferOut>> {
  const locked = await lockStays(c, t)
  if ('ok' in locked) return locked
  const s = locked.a
  const destId = t.toBedId
  if (!destId) return executionFailed(fail.conflict('No destination bed was chosen', 'Accommodation Admin', 'Choose a destination and approve again', { reason: 'no_destination' }))
  const crossSite = isCrossSite(t)

  // Both beds locked in id order BEFORE reading anything about them.
  const beds = await lockBeds(c.tx, [s.bedId, destId])
  const source = beds.find(x => x.id === s.bedId)
  const dest = beds.find(x => x.id === destId)
  if (!source || !dest) return executionFailed(fail.conflict('A bed in this transfer no longer exists', 'Accommodation Admin', 'Choose another destination', { reason: 'bed_unavailable' }))
  if (dest.siteId !== t.destinationSiteId) return executionFailed(fail.conflict('The destination bed is not in the site this move was approved for', `Accommodation Admin of the destination site`, 'Choose a bed in the destination site and approve again', { reason: 'stale' }))
  if (crossSite) {
    const closed = await checkDestinationSite(c.tx, t.destinationSiteId)
    if (closed) return executionFailed(closed)
  }

  // "Today" is where the resident arrives.
  const today = await siteToday(c.tx, t.destinationSiteId, c.now)
  const period = newPeriod(s, today)
  if ('ok' in period) return period

  // The destination is judged first. Nothing is released until it has passed.
  const taken = await takenBy(c, destId, s, period, t.destinationSiteId)
  if (taken) return executionFailed(taken)
  const a = await guarded(c, c2 => allocateBed(c2, { bedId: destId, staffId: s.staffId, from: period.from, to: period.to, kind: 'stay', requireReady: true }))
  if (!a.ok) return executionFailed(a)

  await releaseClaim(c.tx, s.claimId, 'transferred', c.now)
  await c.tx.update(stay).set({ bedId: destId, claimId: a.data.claimId }).where(eq(stay.id, s.id))
  await c.tx.update(bed).set({ state: 'occupied', stateReason: null, stateSince: c.now }).where(eq(bed.id, destId))
  if (source.state === 'occupied') {
    await c.tx.update(bed).set({ state: 'needs_cleaning', stateReason: 'Resident transferred out', stateSince: c.now }).where(eq(bed.id, source.id))
    await openCleaningTask(c.tx, { bedId: source.id, reason: 'Resident transferred out', now: c.now })
  }
  await recordExceptionUse(c.tx, a.data.exceptionIds, { for: 'transfer', ref: t.id, by: c.user.id })
  await c.tx.update(transferRequest).set({ status: 'executed', executedBy: c.user.id, executedAt: c.now, newClaimId: a.data.claimId }).where(eq(transferRequest.id, t.id))

  const sites = crossSite ? { fromSiteId: t.siteId, toSiteId: t.destinationSiteId } : undefined
  const followUps = crossSite ? await runCrossSiteFollowUps(c, { staffId: s.staffId, stayId: s.id, transferId: t.id, ...sites! }) : undefined
  const [fromL, toL] = [await bedLabel(c.tx, s.bedId), await bedLabel(c.tx, destId)]
  const executed = {
    before: { stayId: s.id, bedId: s.bedId, claimId: s.claimId, sourceBed: source.state, destinationBed: dest.state, ...sites },
    after: { stayId: s.id, bedId: destId, claimId: a.data.claimId, sourceBed: 'needs_cleaning', destinationBed: 'occupied', from: period.from, to: period.to ?? null, ...KEYS_PLACEHOLDER, ...sites, ...(followUps ? { followUps } : {}) },
  }
  await audit(c, { action: 'stays.transfer.executed', entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: t.reason, ...executed })
  // The destination site's audit log shows it too: the move into the site is its event as much as the source's.
  if (crossSite) await audit(c, { action: 'stays.transfer.received', entityType: 'transfer_request', entityId: t.id, siteId: t.destinationSiteId, reason: t.reason, ...executed })
  await audit(c, {
    action: 'stays.stay.moved', entityType: 'stay', entityId: s.id, siteId: t.destinationSiteId, reason: t.reason,
    before: { bedId: s.bedId, claimId: s.claimId, ...sites }, after: { bedId: destId, claimId: a.data.claimId, transferId: t.id, ...sites },
  })
  if (crossSite) {
    await audit(c, {
      action: 'stays.stay.left_site', entityType: 'stay', entityId: s.id, siteId: t.siteId, reason: t.reason,
      before: { bedId: s.bedId, claimId: s.claimId, ...sites }, after: { bedId: destId, claimId: a.data.claimId, transferId: t.id, ...sites },
    })
  }
  const who = await staffName(c.tx, s.staffId)
  await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed`, kind: 'transfer.executed', to: { staffId: s.staffId }, ref: { type: 'stay', id: s.id }, text: `You have moved to ${toL}. Please return the key to ${fromL}.` })
  await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:aa`, kind: 'transfer.executed', to: { role: 'AA', siteId: t.siteId }, ref: { type: 'transfer_request', id: t.id }, text: `Transfer done: ${who} moved from ${fromL} to ${toL}. The old bed needs cleaning.` })
  if (crossSite) {
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:aa:destination`, kind: 'transfer.executed', to: { role: 'AA', siteId: t.destinationSiteId }, ref: { type: 'transfer_request', id: t.id }, text: `${who} has moved into ${toL} from ${fromL}.` })
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:rec:destination`, kind: 'transfer.executed', to: { role: 'Rec', siteId: t.destinationSiteId }, ref: { type: 'stay', id: s.id }, text: `${who} arrived in ${toL} from ${await siteNameOf(c.tx, t.siteId)}. Issue the keys for the new bed.` })
  }
  return ok({ id: t.id, kind: 'transfer' as const, status: 'executed' as const, moves: [{ stayId: s.id, fromBed: s.bedId, toBed: destId }] }, `Moved to ${toL}. ${fromL} now needs cleaning.`)
}

/** An overlapping claim on the destination, answered like allocateBed would (taken or held), with beds that are ready now. */
async function takenBy(c: CommandContext, bedId: string, s: StayFull, p: { from: string; to?: string }, siteId: string): Promise<Failure | undefined> {
  const conflicts = await overlappingClaims(c.tx, bedId, p.from, p.to)
  if (conflicts.length === 0) return undefined
  const held = conflicts.some(x => x.kind === 'offer_hold')
  const suggestions = (await suggestBeds(c.tx, { staffId: s.staffId, siteId, from: p.from, to: p.to, limit: 8, excludeBedIds: [bedId, s.bedId], now: c.now })).filter(x => x.state === 'available').slice(0, 3)
  return fail.conflict(
    held ? 'The destination bed is held by a bed offer' : 'The destination bed was taken for those dates',
    held ? 'The offered resident' : 'Accommodation Admin',
    suggestions.length ? 'Choose one of the suggested beds and approve the transfer again' : 'Choose another destination and approve the transfer again',
    { reason: held ? 'bed_held' : 'bed_taken', bedId, conflicts: conflicts.map(x => ({ kind: x.kind, from: x.from, to: x.to })), suggestions },
  )
}

/* ---------------- swap ---------------- */

async function runSwap(c: CommandContext, t: TransferRow): Promise<Result<ExecuteTransferOut>> {
  const locked = await lockStays(c, t)
  if ('ok' in locked) return locked
  const { a: sa } = locked
  const sb = locked.b!
  await lockBeds(c.tx, [sa.bedId, sb.bedId])
  const crossSite = isCrossSite(t)
  if (crossSite) {
    // Both sites must still be live; each person arrives in the OTHER stay's site.
    for (const siteId of [sa.siteId, sb.siteId]) {
      const closed = await checkDestinationSite(c.tx, siteId)
      if (closed) return executionFailed(closed)
    }
  }

  const pa = newPeriod(sa, await siteToday(c.tx, sb.siteId, c.now))
  if ('ok' in pa) return pa
  const pb = newPeriod(sb, await siteToday(c.tx, sa.siteId, c.now))
  if ('ok' in pb) return pb
  const [nameA, nameB] = [await staffName(c.tx, sa.staffId), await staffName(c.tx, sb.staffId)]

  // Each bed is held by the other's occupant right now, so both claims are released inside this transaction first;
  // if either new claim is refused, the whole transaction (including the releases) is rolled back.
  await releaseClaim(c.tx, sa.claimId, 'swapped', c.now)
  await releaseClaim(c.tx, sb.claimId, 'swapped', c.now)
  const toB = await guarded(c, c2 => allocateBed(c2, { bedId: sb.bedId, staffId: sa.staffId, from: pa.from, to: pa.to, kind: 'stay' }))
  if (!toB.ok) return executionFailed(toB, nameA)
  const toA = await guarded(c, c2 => allocateBed(c2, { bedId: sa.bedId, staffId: sb.staffId, from: pb.from, to: pb.to, kind: 'stay' }))
  if (!toA.ok) return executionFailed(toA, nameB)

  await c.tx.update(stay).set({ bedId: sb.bedId, claimId: toB.data.claimId }).where(eq(stay.id, sa.id))
  await c.tx.update(stay).set({ bedId: sa.bedId, claimId: toA.data.claimId }).where(eq(stay.id, sb.id))
  await recordExceptionUse(c.tx, [...toB.data.exceptionIds, ...toA.data.exceptionIds], { for: 'swap', ref: t.id, by: c.user.id })
  await c.tx.update(transferRequest).set({ status: 'executed', executedBy: c.user.id, executedAt: c.now, newClaimId: toB.data.claimId, otherNewClaimId: toA.data.claimId }).where(eq(transferRequest.id, t.id))

  const sites = crossSite ? { fromSiteId: sa.siteId, toSiteId: sb.siteId } : undefined
  const followUps = crossSite
    ? {
      [nameA]: await runCrossSiteFollowUps(c, { staffId: sa.staffId, stayId: sa.id, transferId: t.id, fromSiteId: sa.siteId, toSiteId: sb.siteId }),
      [nameB]: await runCrossSiteFollowUps(c, { staffId: sb.staffId, stayId: sb.id, transferId: t.id, fromSiteId: sb.siteId, toSiteId: sa.siteId }),
    }
    : undefined
  const [labelA, labelB] = [await bedLabel(c.tx, sa.bedId), await bedLabel(c.tx, sb.bedId)]
  const executed = {
    before: { stays: [{ id: sa.id, bedId: sa.bedId, claimId: sa.claimId }, { id: sb.id, bedId: sb.bedId, claimId: sb.claimId }], ...sites },
    after: { stays: [{ id: sa.id, bedId: sb.bedId, claimId: toB.data.claimId }, { id: sb.id, bedId: sa.bedId, claimId: toA.data.claimId }], bothBeds: 'occupied', ...KEYS_PLACEHOLDER, ...sites, ...(followUps ? { followUps } : {}) },
  }
  await audit(c, { action: 'stays.swap.executed', entityType: 'transfer_request', entityId: t.id, siteId: t.siteId, reason: t.reason, ...executed })
  if (crossSite) await audit(c, { action: 'stays.swap.received', entityType: 'transfer_request', entityId: t.id, siteId: t.destinationSiteId, reason: t.reason, ...executed })
  for (const [s, from, to, newSite] of [[sa, sa.bedId, sb.bedId, sb.siteId], [sb, sb.bedId, sa.bedId, sa.siteId]] as const) {
    const moved = crossSite ? { fromSiteId: s.siteId, toSiteId: newSite } : undefined
    await audit(c, { action: 'stays.stay.moved', entityType: 'stay', entityId: s.id, siteId: crossSite ? newSite : t.siteId, reason: t.reason, before: { bedId: from, ...moved }, after: { bedId: to, transferId: t.id, ...moved } })
    if (crossSite) await audit(c, { action: 'stays.stay.left_site', entityType: 'stay', entityId: s.id, siteId: s.siteId, reason: t.reason, before: { bedId: from, ...moved }, after: { bedId: to, transferId: t.id, ...moved } })
  }
  await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:${sa.staffId}`, kind: 'swap.executed', to: { staffId: sa.staffId }, ref: { type: 'stay', id: sa.id }, text: `You have swapped beds: you are now in ${labelB}. Please exchange keys at Reception.` })
  await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:${sb.staffId}`, kind: 'swap.executed', to: { staffId: sb.staffId }, ref: { type: 'stay', id: sb.id }, text: `You have swapped beds: you are now in ${labelA}. Please exchange keys at Reception.` })
  if (crossSite) {
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:aa`, kind: 'swap.executed', to: { role: 'AA', siteId: sa.siteId }, ref: { type: 'transfer_request', id: t.id }, text: `Swap done: ${nameA} is now in ${labelB} and ${nameB} in ${labelA}.` })
    await notify(c.tx, { dedupeKey: `transfer:${t.id}:executed:aa:destination`, kind: 'swap.executed', to: { role: 'AA', siteId: sb.siteId }, ref: { type: 'transfer_request', id: t.id }, text: `Swap done: ${nameA} is now in ${labelB} and ${nameB} in ${labelA}.` })
  }
  return ok({
    id: t.id, kind: 'swap' as const, status: 'executed' as const,
    moves: [{ stayId: sa.id, fromBed: sa.bedId, toBed: sb.bedId }, { stayId: sb.id, fromBed: sb.bedId, toBed: sa.bedId }],
  }, `Swapped: ${nameA} is now in ${labelB}, ${nameB} in ${labelA}.`)
}

/* ---------------- the surviving record of a failed execution ---------------- */

/**
 * Runs AFTER the command's transaction has rolled back, in a transaction of its own. It touches only the request row
 * (status `failed`, the reason, a counter, the destination key cleared; a swap: both keys), one audit event per site and the
 * alerts; never a stay, claim or bed. If this write itself fails the original failure is still returned to the caller: a
 * missing record is logged, not hidden.
 */
async function recordFailure(rc: RequestContext, id: string, f: Failure): Promise<void> {
  try {
    await getDb().transaction(async tx => {
      const [t] = await tx.select().from(transferRequest).where(eq(transferRequest.id, id)).for('update')
      if (!t || t.status !== 'approved') return // someone else already dealt with it
      const now = rc.clock.now()
      const detail = f.detail as { reason?: string; suggestions?: unknown; bedId?: string } | undefined
      const count = t.failureCount + 1
      const crossSite = isCrossSite(t)
      const clearSource = !crossSite || t.kind === 'swap'
      await tx.update(transferRequest).set({
        status: 'failed', failedAt: now, failureCount: count, failureReason: f.reason,
        failureDetail: { reason: detail?.reason ?? null, owner: f.owner ?? null, next: f.next ?? null, bedId: detail?.bedId ?? null, suggestions: detail?.suggestions ?? null },
        destinationApprovedBy: null, destinationApprovedAt: null,
        ...(clearSource ? { sourceApprovedBy: null, sourceApprovedAt: null } : {}),
      }).where(eq(transferRequest.id, id))
      const sites = crossSite ? { fromSiteId: t.siteId, toSiteId: t.destinationSiteId } : {}
      for (const siteId of crossSite ? [t.siteId, t.destinationSiteId] : [t.siteId]) {
        await tx.insert(auditEvent).values({
          actorUserId: rc.user.id, actorRole: rc.actor.role, action: `stays.${t.kind}.failed`, entityType: 'transfer_request', entityId: id, siteId,
          reason: f.reason, before: { status: 'approved' }, after: { status: 'failed', nothingMoved: true, failureReason: detail?.reason ?? null, ...sites }, requestId: rc.requestId,
        })
      }
      const who = await staffName(tx, t.staffId)
      const text = `The ${t.kind} for ${who} could not be carried out and nobody was moved: ${f.reason}. ${f.next ?? 'Choose another destination and approve it again.'}`
      await notify(tx, { dedupeKey: `transfer:${id}:failed:${count}`, kind: `${t.kind}.failed`, to: { role: 'AA', siteId: t.siteId }, ref: { type: 'transfer_request', id }, critical: true, text })
      if (crossSite) await notify(tx, { dedupeKey: `transfer:${id}:failed:${count}:destination`, kind: `${t.kind}.failed`, to: { role: 'AA', siteId: t.destinationSiteId }, ref: { type: 'transfer_request', id }, critical: true, text })
      await notify(tx, {
        dedupeKey: `transfer:${id}:failed:${count}:resident`, kind: `${t.kind}.failed`, to: { staffId: t.staffId }, ref: { type: 'transfer_request', id },
        text: 'Your bed move could not be carried out. You stay where you are; the Accommodation Admin will arrange another option.',
      })
    })
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'could not record the failed transfer', transferId: id, error: e instanceof Error ? e.message : String(e) }))
  }
}
