import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { bed, staffProfile } from '@/server/db/schema'
import { scopeSql } from '@/server/queries/scope'
import { notSelf, authorize } from '@/server/command/authorize'

const render = (s: ReturnType<typeof scopeSql>) => (s ? new PgDialect().sqlToQuery(s) : undefined)

describe('scopeSql', () => {
  it('no restriction for "all"; nothing for "none"', () => {
    expect(scopeSql({ kind: 'all' }, { site: bed.siteId })).toBeUndefined()
    expect(render(scopeSql({ kind: 'none' }, { site: bed.siteId }))?.sql).toBe('false')
  })
  it('restricts to the actor\'s sites', () => {
    const q = render(scopeSql({ kind: 'restricted', siteIds: ['a', 'b'] }, { site: bed.siteId }))!
    expect(q.sql).toContain('"bed"."site_id" in ($1, $2)')
    expect(q.params).toEqual(['a', 'b'])
  })
  it('a scope kind with no column can never widen the result', () => {
    expect(render(scopeSql({ kind: 'restricted', siteIds: ['a'], ownerStaffId: 's' }, { owner: staffProfile.id }))?.sql).toBe('"staff_profile"."id" = $1')
    expect(render(scopeSql({ kind: 'restricted', siteIds: ['a'] }, {}))?.sql).toBe('false')
  })
  it('combines site and own scope with OR', () => {
    const q = render(scopeSql({ kind: 'restricted', siteIds: ['a'], ownerStaffId: 's' }, { site: bed.siteId, owner: bed.roomId }))!
    expect(q.sql).toMatch(/\) or \(|or/)
  })
})

describe('authorize / notSelf', () => {
  const aa = { actor: { role: 'AA' as const, caps: [], sites: ['s1'], staffId: 'me' } }
  it('allowed, out of scope (404) and no grant (403)', () => {
    expect(authorize(aa, 'rooms_beds.manage', { siteId: 's1' })).toBeUndefined()
    expect(authorize(aa, 'rooms_beds.manage', { siteId: 's2' })?.status).toBe(404)
    expect(authorize(aa, 'sites_buildings.create_site')?.status).toBe(403)
  })
  it('refuses acting on one\'s own record', () => {
    expect(notSelf(aa, 'me', 'approve')?.code).toBe('separation_of_duties')
    expect(notSelf(aa, 'other', 'approve')).toBeUndefined()
    expect(notSelf(aa, undefined, 'approve')).toBeUndefined()
  })
})
