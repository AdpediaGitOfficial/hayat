/**
 * Audit log viewer (WP-C, AT-028). Read-only by construction: this module only SELECTs from audit_event, and the
 * database refuses UPDATE/DELETE/TRUNCATE to the application role and to the owner alike.
 *
 * Scope: events are filtered by their `site_id` through the policy (`audit_log.view`). An actor whose scope is 'all'
 * (a Super Admin, or an Auditor with a global assignment) sees everything, including events that belong to no site
 * (sign-ins, grants, global configuration). An actor limited to some sites sees only events recorded against those
 * sites: site-less events are invisible to them. Keyset pagination on `seq` (a total order), newest first.
 */
import { and, desc, eq, ilike, lt, gte, sql } from 'drizzle-orm'
import { getDb } from '@/server/db/client'
import { auditEvent, site, userAccount } from '@/server/db/schema'
import { scopeFilter, type Actor } from '@/server/policy'
import { scopeSql } from '@/server/queries/scope'

export interface AuditFilter {
  /** Action prefix, e.g. 'access.' or 'access.grant'. */
  action?: string
  entityType?: string
  entityId?: string
  /** A username or a user id. */
  actor?: string
  /** Inclusive start, exclusive end. */
  from?: Date
  to?: Date
  /** Keyset cursor: only events with a smaller `seq`. */
  before?: number
  limit?: number
}
export interface AuditRow {
  seq: number
  id: string
  at: string
  action: string
  entityType: string | null
  entityId: string | null
  siteId: string | null
  siteCode: string | null
  actorUserId: string | null
  actorUsername: string | null
  actorRole: string | null
  reason: string | null
  before: unknown
  after: unknown
  requestId: string | null
  ip: string | null
}
export interface AuditPage { rows: AuditRow[]; nextBefore: number | null }

const SECRETISH = /(pass(word|wd)?|secret|token|hash|credential|authorization|cookie)/i

/**
 * Display-time safety net: no secret is ever written to the audit log (commands audit ids and states, never credentials),
 * but a value under a secret-looking key is masked here anyway. Booleans and numbers (mustChangePassword) are left alone.
 */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1))
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      [k, SECRETISH.test(k) && typeof x === 'string' ? '[redacted]' : redact(x, depth + 1)]))
  }
  return v
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, m => `\\${m}`)}%`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function searchAudit(actor: Actor, f: AuditFilter): Promise<AuditPage> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200)
  const scoped = scopeSql(scopeFilter(actor, 'audit_log.view'), { site: auditEvent.siteId })
  const actorFilter = f.actor?.trim()
    ? UUID.test(f.actor.trim())
      ? eq(auditEvent.actorUserId, f.actor.trim())
      : sql`${auditEvent.actorUserId} in (select ${userAccount.id} from ${userAccount} where lower(btrim(${userAccount.username})) = lower(${f.actor.trim()}))`
    : undefined
  const where = and(
    scoped,
    f.action?.trim() ? ilike(auditEvent.action, likePrefix(f.action.trim())) : undefined,
    f.entityType?.trim() ? eq(auditEvent.entityType, f.entityType.trim()) : undefined,
    f.entityId?.trim() ? (UUID.test(f.entityId.trim()) ? eq(auditEvent.entityId, f.entityId.trim()) : sql`false`) : undefined,
    actorFilter,
    f.from ? gte(auditEvent.createdAt, f.from) : undefined,
    f.to ? lt(auditEvent.createdAt, f.to) : undefined,
    f.before !== undefined ? lt(auditEvent.seq, f.before) : undefined,
  )
  const rows = await getDb().select({
    seq: auditEvent.seq, id: auditEvent.id, at: auditEvent.createdAt, action: auditEvent.action, entityType: auditEvent.entityType, entityId: auditEvent.entityId,
    siteId: auditEvent.siteId, siteCode: site.code, actorUserId: auditEvent.actorUserId, actorUsername: userAccount.username, actorRole: auditEvent.actorRole,
    reason: auditEvent.reason, before: auditEvent.before, after: auditEvent.after, requestId: auditEvent.requestId, ip: auditEvent.ip,
  }).from(auditEvent).leftJoin(userAccount, eq(userAccount.id, auditEvent.actorUserId)).leftJoin(site, eq(site.id, auditEvent.siteId))
    .where(where).orderBy(desc(auditEvent.seq)).limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    rows: page.map(r => ({ ...r, seq: Number(r.seq), at: r.at.toISOString(), before: redact(r.before), after: redact(r.after) })),
    nextBefore: rows.length > limit ? Number(page[page.length - 1].seq) : null,
  }
}
