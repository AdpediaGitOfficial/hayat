/** Query-string parsing shared by the API routes and the server-rendered pages of WP-C (one place, so they filter identically). */
import { z } from 'zod'
import { ROLES } from '@/domain/enums'
import type { AuditFilter } from './audit'
import type { UserListFilter } from './users'

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const text = (max = 200) => z.preprocess(blank, z.string().trim().max(max).optional())

/** A day (YYYY-MM-DD, UTC) or a full ISO timestamp. */
const when = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2}))?$/, 'Use a date like 2026-10-14').optional())

export const userListQuery = z.object({
  q: text(), status: z.preprocess(blank, z.enum(['invited', 'active', 'locked', 'revoked']).optional()),
  role: z.preprocess(blank, z.enum(ROLES).optional()),
  page: z.preprocess(blank, z.coerce.number().int().min(1).max(10_000).optional()),
})
export const USERS_PAGE = 50
export function toUserFilter(q: z.infer<typeof userListQuery>): UserListFilter {
  return { q: q.q, status: q.status, role: q.role, limit: USERS_PAGE, offset: ((q.page ?? 1) - 1) * USERS_PAGE }
}

export const auditQuery = z.object({
  action: text(120), entityType: text(60), entityId: text(60), actor: text(120), from: when, to: when,
  before: z.preprocess(blank, z.coerce.number().int().min(1).optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(200).optional()),
})
const DAY = /^\d{4}-\d{2}-\d{2}$/
export function toAuditFilter(q: z.infer<typeof auditQuery>): AuditFilter {
  const from = q.from ? new Date(q.from) : undefined
  let to = q.to ? new Date(q.to) : undefined
  if (to && q.to && DAY.test(q.to)) to = new Date(to.getTime() + 86_400_000) // a bare day means "through the end of that day"
  return { action: q.action, entityType: q.entityType, entityId: q.entityId, actor: q.actor, from, to, before: q.before, limit: q.limit }
}

export const queryOf = (req: Request): Record<string, string> => Object.fromEntries(new URL(req.url).searchParams)

export const configHistoryQuery = z.object({ siteId: z.preprocess(blank, z.uuid().optional()) })

/** A path segment that must be a uuid; anything else can't name a record, so the caller answers 404. */
export const pathId = (params: Record<string, string>, name = 'id'): string | undefined => {
  const r = z.uuid().safeParse(params[name])
  return r.success ? r.data : undefined
}
