/**
 * When does a stay become `closed`? Checkout is not clearance and not bed ready (D-64): `closed` means clearance is
 * complete (stay.closed_at). A stay closes only when it is checked out AND something has cleared it (a closer: the
 * clearance case, registered by WP-H) AND nothing is outstanding against it (blockers: keys and assets now).
 * A voluntary checkout has no clearance case, so it stays `checked_out`: its history is kept and nothing pretends
 * that a clearance happened. closeStayIfDone() is called from checkout, from the return of an item and from closing
 * a clearance case: whichever finishes last closes it.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { bed, stay } from '@/server/db/schema'
import { handoverItem } from '@/server/db/schema.stage3'
import type { Tx } from '@/server/command/context'
import { OUTSTANDING_STATUSES } from '@/server/handover/outstanding'

export interface StayForClose { id: string; staffId: string; bedId: string; roomId: string }
/** Returns why the stay cannot close yet, or undefined. */
export type StayCloseBlocker = (tx: Tx, s: StayForClose) => Promise<string | undefined>

/** True when the stay has been cleared (for example its clearance case is Cleared). */
export type StayCloser = (tx: Tx, s: StayForClose) => Promise<boolean>

const CLOSERS: { id: string; check: StayCloser }[] = []
export function registerStayCloser(id: string, check: StayCloser): void {
  if (!CLOSERS.some(b => b.id === id)) CLOSERS.push({ id, check })
}
const BLOCKERS: { id: string; check: StayCloseBlocker }[] = []
export function registerStayCloseBlocker(id: string, check: StayCloseBlocker): void {
  if (!BLOCKERS.some(b => b.id === id)) BLOCKERS.push({ id, check })
}

registerStayCloseBlocker('handover', async (tx, s) => {
  // Held against this stay: the key or asset of this bed or of this room, still with the person (or lost or damaged and unresolved).
  const rows = await tx.select({ id: handoverItem.id }).from(handoverItem).where(and(
    eq(handoverItem.holderStaffId, s.staffId), inArray(handoverItem.status, [...OUTSTANDING_STATUSES]), isNull(handoverItem.archivedAt),
    or(eq(handoverItem.bedId, s.bedId), eq(handoverItem.roomId, s.roomId)),
  ))
  return rows.length ? `${rows.length} key or asset item${rows.length === 1 ? '' : 's'} not yet returned` : undefined
})

/** Closes the stay if it is checked out and no blocker remains. Returns true if it was closed by this call. */
export async function closeStayIfDone(tx: Tx, stayId: string, now: Date): Promise<boolean> {
  const [s] = await tx.select({ id: stay.id, staffId: stay.staffId, bedId: stay.bedId, status: stay.status, roomId: bed.roomId })
    .from(stay).innerJoin(bed, eq(bed.id, stay.bedId)).where(eq(stay.id, stayId)).limit(1).for('update', { of: stay })
  if (!s || s.status !== 'checked_out') return false
  let cleared = false
  for (const c of CLOSERS) if (await c.check(tx, s)) { cleared = true; break }
  if (!cleared) return false
  for (const b of BLOCKERS) if (await b.check(tx, s)) return false
  await tx.update(stay).set({ status: 'closed', closedAt: now }).where(eq(stay.id, s.id))
  return true
}

export async function stayCloseBlockers(tx: Tx, s: StayForClose): Promise<string[]> {
  const out: string[] = []
  for (const b of BLOCKERS) { const why = await b.check(tx, s); if (why) out.push(why) }
  return out
}
