/**
 * Offers on beds that are not ready (S-22, P-13; AT-021, AT-037). PROPOSED, pending client sign-off: behind `readiness.offer_lead_days`
 * (shipped: 1; 0 = no restriction, the earlier behaviour).
 *
 * The rule: a bed that is not Available (it needs cleaning, waits for the final inspection, or is still occupied) cannot be OFFERED for
 * a start date earlier than today plus the lead time, in the site's time zone. A reservation for a later date on such a bed stays
 * possible (D-18: readiness gates check-in, not the reservation), and so does an offer whose hold starts after the lead time. This is
 * about offers only: check-in keeps its own gate (`requireReady`), and nothing in an offer's life (accepting it, the expiry sweeps)
 * ever turns a bed into a checked-in stay. Blocked, under-maintenance and archived beds are refused by allocateBed for every date, with
 * the Maintenance Coordinator as owner, so they are not repeated here.
 */
import { addDays } from '@/domain/time'
import type { Tx } from '@/server/command/context'
import { fail, type Failure } from '@/server/command/result'
import { getConfig } from '@/server/config/registry'

type Reader = Pick<Tx, 'select'>

const WORDS: Record<string, { what: string; owner: string; next: string }> = {
  needs_cleaning: { what: 'needs cleaning', owner: 'Housekeeping', next: 'Offer it for a later date, or wait for the cleaning and the final inspection' },
  inspection_required: { what: 'is waiting for the final inspection', owner: 'Final Inspection holder', next: 'Offer it for a later date, or wait for the final inspection' },
  occupied: { what: 'is still occupied', owner: 'Reception', next: 'Offer it for a later date, after the checkout, the cleaning and the final inspection' },
}

/** The earliest start date an offer on a bed that is not ready may have (null when the setting is 0: no restriction). */
export async function earliestOfferStart(q: Reader, siteId: string, today: string): Promise<{ earliest: string; leadDays: number } | undefined> {
  const leadDays = await getConfig(q, 'readiness.offer_lead_days', siteId)
  return leadDays > 0 ? { earliest: addDays(today, leadDays), leadDays } : undefined
}

/**
 * The refusal for offering this bed from this date, or undefined when it may be offered. `from` is the first night of the hold,
 * `today` the site-local date. Pure given the setting; one answer shared by createOffer, offerToNext, the freed-bed notice and the
 * list of beds a person could be offered.
 */
export async function offerNotReady(q: Reader, b: { id: string; code: string; state: string; siteId: string }, from: string, today: string): Promise<Failure | undefined> {
  const w = WORDS[b.state]
  if (!w) return undefined // available, or a state allocateBed refuses anyway (blocked, under maintenance, archived)
  const lead = await earliestOfferStart(q, b.siteId, today)
  if (!lead || from >= lead.earliest) return undefined
  return fail.conflict(
    `Bed ${b.code} ${w.what}, so it cannot be offered from ${from}. A bed that is not ready can be offered from ${lead.earliest} (${lead.leadDays} day${lead.leadDays === 1 ? '' : 's'} from today); proposed policy, pending client sign-off`,
    w.owner, w.next,
    { reason: 'bed_not_ready', bedId: b.id, state: b.state, from, earliest: lead.earliest, leadDays: lead.leadDays, proposal: 'P-13' },
  )
}
