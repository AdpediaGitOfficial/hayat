/**
 * Naming the other resident of a swap by EMPLOYEE ID, across sites (S-21, P-11). PROPOSED, pending client sign-off: behind the setting
 * `transfers.swap_partner_lookup`. Off (the shipped default) the other stay id has to come from a list the admin already sees, which
 * is limited to their own sites, exactly as before.
 *
 * What the lookup may reveal: the NAME and the SITE NAME of the person's ACTIVE stay, to someone who may raise swaps. Nothing else, and
 * nothing at all about anyone else: an unknown employee ID, a person with no active stay, a person who has left and a stay that is
 * only provisional all get the SAME answer, so the lookup cannot be used to find out who lives in the accommodation or who has left.
 *
 * Every lookup (found or not) is counted per actor in `login_attempt`, the way the password re-confirmation counts its attempts: the
 * rows are written outside the command's transaction so a refused lookup still counts. Too many in the window answers "rate limited".
 */
import { and, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { bed, loginAttempt, site, staffProfile, stay } from '@/server/db/schema'
import { getDb } from '@/server/db/client'
import { runCommand } from '@/server/command/run'
import type { CommandContext, RequestContext } from '@/server/command/context'
import { fail, failure, ok, type Failure, type Result } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'
import { decide } from '@/server/policy'
import { policyNotInForce, receptionGate } from './transferShared'

/** OPEN: the number of lookups per actor and the window are not registry settings yet (the lead owns the registry). Reported, not decided. */
export const LOOKUP_LIMIT = 20
export const LOOKUP_WINDOW_MINUTES = 10
const throttleKey = (userId: string) => `swaplookup:${userId}`

/** Not found, whatever the reason: one wording for "unknown", "left", "no active stay" and "not yet checked in". */
export const noActiveStay = () => failure('not_found', 'No active stay was found for that employee ID', {
  owner: 'Accommodation Admin', next: 'Check the employee ID. Only a resident with an active stay can swap beds', detail: { reason: 'no_active_stay' },
})

/** May this actor raise swaps at all? The Accommodation Admin or Super Admin (a site where they have scope), or Reception when P-09 is on. */
export function mayLookUp(c: Pick<CommandContext, 'actor'>): boolean {
  return decide(c.actor, 'transfers_swaps.approve').allowed || (c.actor.role === 'Rec' && decide(c.actor, 'transfers_swaps.request').allowed)
}

export interface PartnerHit { stayId: string; staffId: string; name: string; siteId: string; siteName: string }

/**
 * Throttles, then resolves an employee ID to an active stay. Returns the hit, or ONE failure for every way of not finding. The counter
 * row is inserted on its own connection so it survives the command rolling back.
 */
export async function resolvePartner(c: CommandContext, employeeId: string): Promise<Failure | PartnerHit> {
  const db = getDb()
  const since = new Date(c.now.getTime() - LOOKUP_WINDOW_MINUTES * 60_000)
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempt)
    .where(and(eq(loginAttempt.usernameNorm, throttleKey(c.user.id)), gt(loginAttempt.createdAt, since)))
  if (n >= LOOKUP_LIMIT) return fail.rateLimited(LOOKUP_WINDOW_MINUTES)
  await db.insert(loginAttempt).values({ usernameNorm: throttleKey(c.user.id), ip: c.ip ?? null, succeeded: false, createdAt: c.now })

  const key = employeeId.trim().toLowerCase()
  if (!key) return noActiveStay()
  const [r] = await c.tx.select({ stayId: stay.id, staffId: staffProfile.id, name: staffProfile.fullName, siteId: site.id, siteName: site.name })
    .from(staffProfile).innerJoin(stay, eq(stay.staffId, staffProfile.id)).innerJoin(bed, eq(bed.id, stay.bedId)).innerJoin(site, eq(site.id, bed.siteId))
    .where(and(sql`lower(btrim(${staffProfile.employeeId})) = ${key}`, eq(staffProfile.employmentStatus, 'active'), eq(stay.status, 'active'))).limit(1)
  return r ?? noActiveStay()
}

/** Is the lookup switched on? (Per-site wording of the setting is not needed: it is one switch for the proposal.) */
export async function lookupAllowed(c: Pick<CommandContext, 'tx' | 'actor'>): Promise<Failure | undefined> {
  if (!mayLookUp(c)) return fail.forbidden('look up a swap partner (transfers_swaps.approve)')
  const reception = await receptionGate(c) // Reception may look up only when it may also raise (P-09)
  if (reception) return reception
  if (!(await getConfig(c.tx, 'transfers.swap_partner_lookup'))) {
    return policyNotInForce('P-11', 'Naming the other resident by employee ID is not available', {
      owner: 'Accommodation Admin', next: 'Choose the other resident from the list of stays you can see',
    })
  }
  return undefined
}

export const lookupInput = z.object({ employeeId: z.string().trim().min(1, 'Enter the employee ID').max(40) })
export type LookupSwapPartnerInput = z.infer<typeof lookupInput>
export interface SwapPartnerOut { name: string; siteName: string }

/** The preview behind the swap form: who is behind this employee ID. Reveals the name and the site name of an active stay, nothing else. */
export function lookupSwapPartner(rc: RequestContext, i: LookupSwapPartnerInput): Promise<Result<SwapPartnerOut>> {
  return runCommand(rc, async c => {
    const denied = await lookupAllowed(c)
    if (denied) return denied
    const hit = await resolvePartner(c, i.employeeId)
    if ('ok' in hit) return hit
    return ok({ name: hit.name, siteName: hit.siteName })
  })
}
