/**
 * Staff reads. One query layer, four shapes (see access.ts). Every function takes the Actor, decides the shape and the row
 * restriction itself, and selects only that shape's columns, so a caller cannot ask for more than the role allows.
 */
import { and, asc, count, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '@/server/db/client'
import type { Actor } from '@/server/policy'
import { staffProfile as s } from '@/server/db/schema'
import { employeeKey, likePattern, staffAccess, type StaffAccess, type StaffShape } from './access'
import type { StaffRecord } from './shapes'

type Reader = Pick<Db, 'select' | 'selectDistinct'>

const IDENTITY = { id: s.id, employeeId: s.employeeId, fullName: s.fullName, employmentStatus: s.employmentStatus }
const MINIMUM = { ...IDENTITY, department: s.department }
const OWN = {
  ...MINIMUM, gender: s.gender, grade: s.grade, phone: s.phone, email: s.email, emergencyContact: s.emergencyContact, joiningDate: s.joiningDate,
}
const FULL = { ...OWN, leftEffective: s.leftEffective, source: s.source, archivedAt: s.archivedAt, createdAt: s.createdAt, updatedAt: s.updatedAt }
const COLUMNS = { full: FULL, own: OWN, minimum: MINIMUM, identity: IDENTITY } as const

/** Which filters a shape may use: never one on a field the shape hides (that would let a filter reveal the hidden value). */
const FILTERABLE: Record<StaffShape, { department: boolean; status: boolean }> = {
  full: { department: true, status: true },
  own: { department: false, status: false },
  minimum: { department: true, status: true },
  identity: { department: false, status: true },
}

export const MAX_PAGE = 100
export const MIN_SEARCH = 2

export interface ListParams {
  q?: string
  department?: string
  status?: 'active' | 'left'
  includeArchived?: boolean
  limit?: number
  offset?: number
}

export interface StaffList {
  shape: StaffShape
  items: StaffRecord[]
  total: number
  limit: number
  offset: number
  /** Lookup roles must search: nothing is listed until they do. */
  needsSearch: boolean
}

function conditions(a: StaffAccess, p: ListParams): { where: SQL | undefined; blocked: boolean } {
  const q = (p.q ?? '').trim()
  const conds: (SQL | undefined)[] = [a.where]
  if (a.searchRequired && q.length < MIN_SEARCH) return { where: undefined, blocked: true }
  if (q) {
    const pat = likePattern(q)
    conds.push(or(ilike(s.fullName, pat), ilike(s.employeeId, pat)))
  }
  const f = FILTERABLE[a.shape]
  if (f.department && p.department) conds.push(sql`lower(btrim(${s.department})) = ${p.department.trim().toLowerCase()}`)
  if (f.status && p.status) conds.push(eq(s.employmentStatus, p.status))
  if (!(a.mayIncludeArchived && p.includeArchived)) conds.push(isNull(s.archivedAt))
  return { where: and(...conds), blocked: false }
}

/** The staff the actor may see, or null when the actor's role has no access to the directory at all. */
export async function listStaff(db: Reader, actor: Actor, p: ListParams = {}): Promise<StaffList | null> {
  const a = staffAccess(actor)
  if (!a) return null
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 25) || 25, 1), MAX_PAGE)
  const offset = Math.max(Math.trunc(p.offset ?? 0) || 0, 0)
  const { where, blocked } = conditions(a, p)
  if (blocked) return { shape: a.shape, items: [], total: 0, limit, offset, needsSearch: true }
  const items = await db.select(COLUMNS[a.shape]).from(s).where(where)
    .orderBy(asc(sql`lower(${s.fullName})`), asc(s.id)).limit(limit).offset(offset)
  const [{ n }] = await db.select({ n: count() }).from(s).where(where)
  return { shape: a.shape, items: items as StaffRecord[], total: Number(n), limit, offset, needsSearch: false }
}

export type StaffLookup =
  | { kind: 'found'; shape: StaffShape; staff: StaffRecord }
  | { kind: 'missing' }
  /** The actor holds no read access to the directory at all. */
  | { kind: 'no_access' }
  /** The actor may see only their own record and asked for someone else's (nothing was fetched). */
  | { kind: 'not_own'; shape: StaffShape }

export async function getStaff(db: Reader, actor: Actor, id: string): Promise<StaffLookup> {
  const a = staffAccess(actor)
  if (!a) return { kind: 'no_access' }
  if (a.ownOnly && actor.staffId !== id) return { kind: 'not_own', shape: a.shape }
  const conds: (SQL | undefined)[] = [eq(s.id, id), a.where]
  if (!a.mayIncludeArchived) conds.push(isNull(s.archivedAt))
  const [row] = await db.select(COLUMNS[a.shape]).from(s).where(and(...conds)).limit(1)
  return row ? { kind: 'found', shape: a.shape, staff: row as StaffRecord } : { kind: 'missing' }
}

/** Distinct departments for the filter. Only for shapes that may see departments. */
export async function listDepartments(db: Reader, actor: Actor): Promise<string[]> {
  const a = staffAccess(actor)
  if (!a || !FILTERABLE[a.shape].department) return []
  const rows = await db.selectDistinct({ d: s.department }).from(s).where(and(a.where, isNull(s.archivedAt))).orderBy(asc(s.department))
  return rows.map(r => r.d).filter((d): d is string => !!d && d.trim() !== '')
}

/** The full-shape record by id for the write side, regardless of read access (the command already authorised the write). */
export async function fullRecord(db: Reader, id: string) {
  const [row] = await db.select(FULL).from(s).where(eq(s.id, id)).limit(1)
  return row
}

export { employeeKey }
