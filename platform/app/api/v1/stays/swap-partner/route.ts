import { route } from '@/server/http'
import { lookupInput, lookupSwapPartner } from '@/server/commands/stays/swapPartner'

export const dynamic = 'force-dynamic'

/**
 * Who is behind this employee ID, for the swap form (S-21, P-11: proposed, pending client sign-off; refused while
 * `transfers.swap_partner_lookup` is off). Answers the NAME and the SITE NAME of an active stay and nothing else; an unknown ID, a
 * person who left and a person with no active stay all get the same answer. Counted per person, so it cannot be used to scan.
 * The guard is "may view transfers"; the command checks that the caller may raise a swap.
 */
export const POST = route({
  name: 'stays.swap.partner_lookup',
  access: { kind: 'action', action: 'transfers_swaps.view' },
  body: lookupInput,
  handler: (rc, body) => lookupSwapPartner(rc, body),
})
