/**
 * In-app notifications (email delivery is Stage 5; email_status stays 'pending').
 *
 * notify() runs inside the business transaction, so a rolled-back command leaves no notification, and the
 * unique dedupe key makes a retried event produce ONE notification (AT-030). A failure to deliver anything later
 * never changes business state: nothing here can fail a command except a programming error.
 *
 * Build keys from the event, not from the clock: `offer:${offerId}:created`, `approval:${kind}:${ref}:level${n}`.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { notification } from '@/server/db/schema.alloc'
import type { Db } from '@/server/db/client'
import type { Capability, Role } from '@/domain/enums'
import type { Actor } from '@/server/policy'

type Writer = Pick<Db, 'insert'>

export type Recipient = { staffId: string } | { role: Role | Capability; siteId?: string }
export interface NotifyInput {
  dedupeKey: string
  kind: string
  to: Recipient
  text: string
  ref?: { type: string; id: string }
  critical?: boolean
}

/** Returns true if a notification was created, false if this event had already been notified. */
export async function notify(tx: Writer, n: NotifyInput): Promise<boolean> {
  const rows = await tx.insert(notification).values({
    dedupeKey: n.dedupeKey, kind: n.kind, text: n.text, critical: n.critical ?? false,
    toStaffId: 'staffId' in n.to ? n.to.staffId : null,
    toRole: 'role' in n.to ? n.to.role : null,
    siteId: 'role' in n.to ? n.to.siteId ?? null : null,
    refType: n.ref?.type ?? null, refId: n.ref?.id ?? null,
  }).onConflictDoNothing({ target: notification.dedupeKey }).returning({ id: notification.id })
  return rows.length > 0
}

export async function notifyMany(tx: Writer, list: NotifyInput[]): Promise<number> {
  let created = 0
  for (const n of list) if (await notify(tx, n)) created++
  return created
}

/** What an actor may see: their own, plus those addressed to their active role or a capability they hold, within their sites. */
export function visibleTo(actor: Actor) {
  const roles: (Role | Capability)[] = [actor.role, ...actor.caps]
  const own = actor.staffId ? eq(notification.toStaffId, actor.staffId) : undefined
  const bySite = actor.sites === 'all'
    ? undefined
    : actor.sites.length ? or(isNull(notification.siteId), inArray(notification.siteId, [...actor.sites])) : isNull(notification.siteId)
  const byRole = and(inArray(notification.toRole, roles), bySite)
  return own ? or(own, byRole)! : byRole!
}

export async function listNotifications(db: Pick<Db, 'select'>, actor: Actor, o: { unreadOnly?: boolean; limit?: number } = {}) {
  return db.select().from(notification)
    .where(and(visibleTo(actor), o.unreadOnly ? isNull(notification.readAt) : undefined))
    .orderBy(desc(notification.createdAt)).limit(Math.min(o.limit ?? 50, 200))
}

export async function unreadCount(db: Pick<Db, 'select'>, actor: Actor): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(notification).where(and(visibleTo(actor), isNull(notification.readAt)))
  return r.n
}
