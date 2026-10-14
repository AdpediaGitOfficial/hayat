/** Pieces shared by the transfer and swap commands (request, consent, approve, reject, execute, cancel). */
import { and, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import { bed, site } from '@/server/db/schema'
import { transferRequest } from '@/server/db/schema.stays'
import type { CommandContext, Tx } from '@/server/command/context'
import { fail, failure, type Failure, type Result } from '@/server/command/result'
import { mapDbError } from '@/server/command/run'
import { decide } from '@/server/policy'
import { checkEligibility } from '@/server/eligibility'
import { getConfig, type ConfigKey } from '@/server/config/registry'
import { authorizeDecision, staffName } from './shared'

export type TransferRow = typeof transferRequest.$inferSelect

export async function loadTransfer(tx: Tx, id: string, lock: boolean): Promise<TransferRow | undefined> {
  const q = tx.select().from(transferRequest).where(eq(transferRequest.id, id))
  return lock ? (await q.for('update'))[0] : (await q)[0]
}

/** Open transfers or swaps that already involve one of these stays (a stay is in at most one at a time). */
export async function openTransfersFor(tx: Tx, stayIds: string[]): Promise<TransferRow[]> {
  return tx.select().from(transferRequest).where(and(
    inArray(transferRequest.status, ['requested', 'approved']),
    or(inArray(transferRequest.stayId, stayIds), inArray(transferRequest.otherStayId, stayIds)),
  ))
}

export const consentVia = z.enum(['in_person', 'phone', 'written'])
export const consentInput = z.object({ via: consentVia, note: z.string().trim().max(300).nullish().transform(v => v ?? null) })

/**
 * The destination of a transfer must be a live bed of the DESTINATION site the request names (D-104: that may be another site than
 * the stay's), and not the bed the person is already in.
 */
export async function checkDestination(tx: Tx, o: { siteId: string; currentBedId: string }, bedId: string): Promise<Failure | undefined> {
  const [b] = await tx.select({ id: bed.id, siteId: bed.siteId, archivedAt: bed.archivedAt, state: bed.state }).from(bed).where(eq(bed.id, bedId)).limit(1)
  if (!b) return fail.invalid('That bed does not exist', { destinationBedId: 'Choose a bed from the list' })
  if (b.siteId !== o.siteId) {
    return fail.conflict('That bed is not in the site this move is going to', 'Accommodation Admin of the destination site', 'Choose a bed in the destination site', { reason: 'wrong_site' })
  }
  if (b.id === o.currentBedId) return fail.invalid('The destination is the bed the resident is already in', { destinationBedId: 'Choose a different bed' })
  if (b.archivedAt || b.state === 'archived') {
    return failure('invalid', 'That bed is archived', { fields: { destinationBedId: 'Choose a different bed' }, owner: 'Accommodation Admin', next: 'Choose a different bed in the destination site', detail: { reason: 'bed_archived', bedId: b.id } })
  }
  return undefined
}

/* ---------------- proposed policies (pending client sign-off) ---------------- */

const POLICY_ASKS: Record<'P-09' | 'P-10' | 'P-11', { setting: ConfigKey }> = {
  'P-09': { setting: 'transfers.reception_may_raise' },
  'P-10': { setting: 'transfers.exception_path' },
  'P-11': { setting: 'transfers.swap_partner_lookup' },
}

/**
 * The refusal for something a PROPOSED policy would allow while its setting is off. It never calls the policy approved: the wording is
 * "policy not in force: proposed, pending client sign-off". Owner and next action say who can still get the thing done today.
 */
export function policyNotInForce(policy: 'P-09' | 'P-10' | 'P-11', what: string, o: { owner: string; next: string }): Failure {
  return failure('forbidden', `${what}: policy not in force: proposed, pending client sign-off (${policy})`, {
    owner: o.owner, next: o.next, detail: { reason: 'policy_not_in_force', policy, setting: POLICY_ASKS[policy].setting },
  })
}

/**
 * P-09 (proposed, pending client sign-off): Reception may raise a transfer or swap on behalf of a resident at their site. The policy table
 * carries the grant; this is the setting that switches it on. Only a Reception actor is gated: the resident (own stay) and an Accommodation
 * Admin are unaffected. Reception never approves, with the setting on or off (the approval actions do not include Reception).
 */
export async function receptionGate(c: Pick<CommandContext, 'tx' | 'actor'>, siteId?: string): Promise<Failure | undefined> {
  if (c.actor.role !== 'Rec') return undefined
  if (await getConfig(c.tx, 'transfers.reception_may_raise', siteId)) return undefined
  return policyNotInForce('P-09', 'Reception cannot raise a transfer or swap', { owner: 'Accommodation Admin', next: 'Ask an Accommodation Admin to raise it' })
}

/** P-10 (proposed, pending client sign-off): may a Policy Approver grant a recorded exception for a transfer destination? */
export const exceptionPathOn = (q: Pick<Tx, 'select'>, siteId?: string) => getConfig(q, 'transfers.exception_path', siteId)

/**
 * Early eligibility check at the DESTINATION for a cross-site move (D-104): the destination site's gender and grade rules apply, not the
 * source's. Same wording and owner as the allocation refusal (a Policy Approver exception, if one exists for this person and site, passes).
 * Execution revalidates anyway (allocateBed); this only saves a doomed request. `transferId` lets an exception granted for THIS transfer
 * (P-10, proposed, pending client sign-off) count; without it only a person-and-site exception does.
 *
 * The refusal says whether the exception path is open (`detail.canAskException`: P-10 on and every failure is one a Policy Approver may
 * waive). With it off the next action no longer points at a Policy Approver, because for a transfer that route is not in force.
 */
export async function checkEligibleAt(c: Pick<CommandContext, 'tx' | 'now'>, staffId: string, bedId: string, o: { transferId?: string } = {}): Promise<Failure | undefined> {
  const e = await checkEligibility(c.tx, staffId, bedId, c.now, { transferId: o.transferId })
  if (!e) return fail.notFound()
  if (e.ok) return undefined
  const open = e.exceptionable && await exceptionPathOn(c.tx)
  return fail.conflict(e.reasons.join('; '), e.exceptionable ? 'Policy Approver' : 'Accommodation Admin',
    !e.exceptionable ? 'Not eligible for accommodation'
      : open ? 'Ask a Policy Approver for an exception, or choose an eligible bed'
        : 'Choose an eligible bed (a Policy Approver exception for a transfer is not in force: proposed, pending client sign-off)',
    { reason: 'not_eligible', failed: e.failed, exceptionable: e.exceptionable, canAskException: open })
}

/**
 * What to do with a destination refusal (from `checkEligibleAt`) when the caller may have asked to go on regardless (P-10, proposed,
 * pending client sign-off). Returns the failure to hand back, or undefined = go on: the move is recorded and waits for a Policy
 * Approver's exception. Going on needs BOTH the explicit ask and an open exception path; a left employee is never exceptionable, and
 * with the path closed the answer says the policy is not in force instead of pretending a Policy Approver could help.
 */
export function exceptionAnswer(refusal: Failure, ask: boolean | undefined): Failure | undefined {
  const d = (refusal.detail ?? {}) as { exceptionable?: boolean; canAskException?: boolean }
  if (!ask || !d.exceptionable) return refusal
  if (d.canAskException) return undefined
  return policyNotInForce('P-10', 'A Policy Approver exception for this transfer cannot be asked for', {
    owner: 'Accommodation Admin', next: 'Choose a bed the person is eligible for. The exception path for transfers is proposed and not in force (pending client sign-off)',
  })
}

/** A site a resident can be moved into: it exists and is not archived. */
export async function checkDestinationSite(tx: Pick<Tx, 'select'>, siteId: string): Promise<Failure | undefined> {
  const [s] = await tx.select({ id: site.id, archivedAt: site.archivedAt }).from(site).where(eq(site.id, siteId)).limit(1)
  if (!s) return fail.invalid('That site does not exist', { destinationSiteId: 'Choose a site from the list' })
  if (s.archivedAt) return fail.conflict('That site is archived, so nobody can be moved into it', 'Super Admin', 'Choose another site', { reason: 'site_archived', siteId })
  return undefined
}

export async function siteNameOf(q: Pick<Tx, 'select'>, siteId: string): Promise<string> {
  const [s] = await q.select({ n: site.name }).from(site).where(eq(site.id, siteId)).limit(1)
  return s?.n ?? 'the site'
}

/* ---------------- the two keys (D-104) ---------------- */

export const isCrossSite = (t: Pick<TransferRow, 'siteId' | 'destinationSiteId'>) => t.siteId !== t.destinationSiteId

/** Which keys are still missing. A same-site request has both keys given by one decision, so it is either both or none. */
export function missingKeys(t: Pick<TransferRow, 'sourceApprovedAt' | 'destinationApprovedAt'>): ('source' | 'destination')[] {
  return [t.sourceApprovedAt ? null : 'source', t.destinationApprovedAt ? null : 'destination'].filter((x): x is 'source' | 'destination' => x !== null)
}

/**
 * Who owns the next step of an open request, in plain words: "the Accommodation Admin of <site>" for each missing key (a same-site
 * request just says "an Accommodation Admin"). Used by every refusal that is really "not approved yet".
 */
export async function waitingForApproval(tx: Pick<Tx, 'select'>, t: Pick<TransferRow, 'siteId' | 'destinationSiteId' | 'sourceApprovedAt' | 'destinationApprovedAt'>): Promise<{ text: string; owner: string; sites: string[] } | undefined> {
  const missing = missingKeys(t)
  if (missing.length === 0) return undefined
  if (!isCrossSite(t)) return { text: 'an Accommodation Admin', owner: 'Accommodation Admin', sites: [] }
  const sites = await Promise.all(missing.map(k => siteNameOf(tx, k === 'source' ? t.siteId : t.destinationSiteId)))
  return {
    text: sites.map(n => `the Accommodation Admin of ${n}`).join(' and '),
    owner: sites.map(n => `Accommodation Admin of ${n}`).join(' and '),
    sites,
  }
}

export interface SideAuthority { source: boolean; destination: boolean }

/**
 * May this actor give the source key, the destination key, or both? Each side is judged exactly like a same-site decision always was
 * (`authorizeDecision`: the Accommodation Admin of THAT site, or a backup approver or Policy Approver of that site once the SLA clock has
 * routed it there). Scope is never widened: a grant at one site says nothing about the other. When neither side is allowed the refusal is
 * "not found" if the actor has no business at either site (a third site's admin), otherwise the most informative refusal.
 */
export async function sideAuthority(c: CommandContext, t: TransferRow): Promise<SideAuthority | Failure> {
  const since = t.failedAt && t.failedAt > t.createdAt ? t.failedAt : t.createdAt
  const src = await authorizeDecision(c, { kind: 'transfer', siteId: t.siteId, since })
  const dst = isCrossSite(t) ? await authorizeDecision(c, { kind: 'transfer', siteId: t.destinationSiteId, since }) : src
  if (src && dst) return src.code === 'not_found' ? dst : src
  return { source: !src, destination: !dst }
}
export const isFailure = (x: SideAuthority | Failure): x is Failure => 'ok' in x

/** May this actor act on the request as an Accommodation Admin of either site? (consent, withdrawal.) */
export function adminOfEither(c: Pick<CommandContext, 'actor'>, t: Pick<TransferRow, 'siteId' | 'destinationSiteId'>): boolean {
  return decide(c.actor, 'transfers_swaps.approve', { siteId: t.siteId }).allowed || decide(c.actor, 'transfers_swaps.approve', { siteId: t.destinationSiteId }).allowed
}

/** Marks a failure as "the move was attempted and could not be completed": the wrapper records it after the rollback. */
export function executionFailed(f: Failure, prefix?: string): Failure {
  const detail = { ...(typeof f.detail === 'object' && f.detail !== null ? f.detail as object : {}), executionFailed: true }
  return { ...f, reason: prefix ? `${prefix}: ${f.reason}` : f.reason, detail }
}
export const isExecutionFailure = (f: Failure) => (f.detail as { executionFailed?: boolean } | undefined)?.executionFailed === true

/**
 * Runs `fn` inside a savepoint. A database refusal (the exclusion constraint, a transition guard) becomes a normal failure
 * and the surrounding transaction stays usable; the caller then returns it, which rolls the whole command back.
 */
export async function guarded<T>(c: CommandContext, fn: (c2: CommandContext) => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await c.tx.transaction(async sp => {
      const r = await fn({ ...c, tx: sp as unknown as Tx })
      if (!r.ok) throw new Soft(r)
      return r
    })
  } catch (e) {
    if (e instanceof Soft) return e.failure as Failure
    const mapped = mapDbError(e)
    if (mapped) return mapped
    throw e
  }
}
class Soft extends Error { constructor(readonly failure: Failure) { super(failure.reason) } }

export async function involvedNames(tx: Tx, t: Pick<TransferRow, 'staffId' | 'otherStaffId'>): Promise<string> {
  const a = await staffName(tx, t.staffId)
  return t.otherStaffId ? `${a} and ${await staffName(tx, t.otherStaffId)}` : a
}

export const OPEN_TRANSFER: TransferRow['status'][] = ['requested', 'approved', 'failed']
