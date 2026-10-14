import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, ROLES, type Capability, type Role } from '@/domain/enums'
import {
  ALL_ACTIONS, MODULE_LABELS, POLICY, can, decide, roleHoldsAnyInModule, scopeFilter, type Actor, type ModuleId,
} from '@/server/policy'

const actor = (role: Role, over: Partial<Actor> = {}): Actor => ({ role, caps: [], sites: ['s1'], staffId: 'staff-1', ...over })

describe('deny by default', () => {
  it('denies unknown actions, malformed actions and prototype-chain lookups', () => {
    const sa = actor('SA', { sites: 'all' })
    for (const a of ['', 'nope', 'nope.nope', 'users_roles', 'users_roles.', '.view', 'users_roles.nope', 'users_roles.constructor',
      '__proto__.view', 'constructor.name', 'toString.view', 'users_roles.__proto__']) {
      expect(can(sa, a), a).toBe(false)
      expect(decide(sa, a)).toEqual({ allowed: false, reason: 'unknown_action' })
    }
  })

  it('denies an unknown role or capability outright', () => {
    expect(can({ role: 'Root' as Role, caps: [], sites: 'all' }, 'users_roles.view')).toBe(false)
    expect(can({ role: 'toString' as Role, caps: [], sites: 'all' }, 'users_roles.view')).toBe(false)
    expect(can(actor('Res', { caps: ['SuperUser' as Capability, '__proto__' as Capability] }), 'rooms_beds.manage')).toBe(false)
  })

  it('a role without a grant is refused with no_grant', () => {
    expect(decide(actor('Tech'), 'rooms_beds.manage', { siteId: 's1' })).toEqual({ allowed: false, reason: 'no_grant' })
    expect(decide(actor('Res'), 'requests_waitlist.approve')).toEqual({ allowed: false, reason: 'no_grant' })
  })

  it('without a resource, can() agrees exactly with the table for every role and action', () => {
    for (const role of ROLES) {
      for (const action of ALL_ACTIONS) {
        const [mod, act] = action.split('.') as [ModuleId, string]
        const expected = Object.hasOwn((POLICY[mod].actions as Record<string, { roles: object }>)[act].roles, role)
        expect(can(actor(role), action), `${role} ${action}`).toBe(expected)
      }
    }
  })

  it('every action has at least one holder, and action ids are unique', () => {
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length)
    for (const action of ALL_ACTIONS) {
      const [mod, act] = action.split('.') as [ModuleId, string]
      const def = (POLICY[mod].actions as Record<string, { roles: object; caps?: object }>)[act]
      expect(Object.keys(def.roles).length + Object.keys(def.caps ?? {}).length, action).toBeGreaterThan(0)
    }
  })
})

describe('scope', () => {
  it('a site-scoped action is allowed in an assigned site and denied in any other', () => {
    const aa = actor('AA', { sites: ['s1', 's2'] })
    expect(can(aa, 'requests_waitlist.approve', { siteId: 's1' })).toBe(true)
    expect(can(aa, 'requests_waitlist.approve', { siteId: 's2' })).toBe(true)
    expect(decide(aa, 'requests_waitlist.approve', { siteId: 's3' })).toEqual({ allowed: false, reason: 'out_of_scope' })
  })

  it('fails closed when the resource does not say which site it belongs to', () => {
    expect(can(actor('AA'), 'requests_waitlist.approve', {})).toBe(false)
    expect(can(actor('SA', { sites: 'all' }), 'rooms_beds.manage', {})).toBe(false)
  })

  it("'all' sites reaches every site, but an SA narrowed to one site is only that site's SA", () => {
    expect(can(actor('SA', { sites: 'all' }), 'rooms_beds.manage', { siteId: 'anything' })).toBe(true)
    expect(can(actor('SA', { sites: ['s1'] }), 'rooms_beds.manage', { siteId: 's2' })).toBe(false)
  })

  it('an actor with no sites can do nothing site-scoped', () => {
    expect(can(actor('AA', { sites: [] }), 'requests_waitlist.approve', { siteId: 's1' })).toBe(false)
  })

  it("'own' scope: a resident reaches their own records only, and needs a staff record to reach any", () => {
    const res = actor('Res', { staffId: 'me' })
    expect(can(res, 'requests_waitlist.view', { ownerStaffId: 'me' })).toBe(true)
    expect(can(res, 'requests_waitlist.view', { ownerStaffId: 'someone-else' })).toBe(false)
    expect(can(res, 'requests_waitlist.view', {})).toBe(false)
    expect(can(actor('Res', { staffId: undefined }), 'requests_waitlist.view', { ownerStaffId: undefined })).toBe(false)
  })

  it("'job' scope: a technician reaches only jobs assigned to them", () => {
    const tech = actor('Tech', { staffId: 't1' })
    expect(can(tech, 'maintenance.work_assigned', { assigneeStaffId: 't1' })).toBe(true)
    expect(can(tech, 'maintenance.work_assigned', { assigneeStaffId: 't2', siteId: 's1' })).toBe(false)
    expect(can(tech, 'maintenance.work_assigned', { siteId: 's1' })).toBe(false)
  })

  it('a resident having a site does not give them site-wide reach on own-scoped actions', () => {
    expect(can(actor('Res', { sites: 'all', staffId: 'me' }), 'requests_waitlist.view', { siteId: 's1', ownerStaffId: 'other' })).toBe(false)
  })
})

describe('capability grants add actions, never scope (D-22)', () => {
  it('BuildingCreation lets an AA create buildings in their own sites only', () => {
    const plain = actor('AA', { sites: ['s1'] })
    const withCap = actor('AA', { sites: ['s1'], caps: ['BuildingCreation'] })
    expect(can(plain, 'sites_buildings.create_building', { siteId: 's1' })).toBe(false)
    expect(can(withCap, 'sites_buildings.create_building', { siteId: 's1' })).toBe(true)
    expect(can(withCap, 'sites_buildings.create_building', { siteId: 's2' })).toBe(false)
  })

  it('PolicyApprover adds exception decisions but does not widen the approver to other sites', () => {
    const pa = actor('Res', { sites: ['s1'], caps: ['PolicyApprover'], staffId: 'pa' })
    expect(can(pa, 'requests_waitlist.approve_exception', { siteId: 's1' })).toBe(true)
    expect(can(pa, 'requests_waitlist.approve_exception', { siteId: 's2' })).toBe(false)
  })

  it('a capability grants only the actions listed for it, not the rest of the holder-typical role', () => {
    const rec = actor('Rec', { caps: ['PolicyApprover'] })
    expect(can(rec, 'rooms_beds.manage', { siteId: 's1' })).toBe(false)
    expect(can(rec, 'requests_waitlist.approve', { siteId: 's1' })).toBe(false)
    expect(can(actor('Res', { caps: ['EmergencyCheckin'] }), 'emergency_checkin.approve', { siteId: 's1' })).toBe(false)
  })

  it('a capability on an actor with no sites yields nothing site-scoped', () => {
    expect(can(actor('Res', { sites: [], caps: ['FinalInspection'] }), 'housekeeping_readiness.final_inspection', { siteId: 's1' })).toBe(false)
  })

  it('Housekeeping reaches assigned rooms only, whatever site the actor has', () => {
    const hk = actor('Res', { caps: ['Housekeeping'], staffId: 'hk1', sites: 'all' })
    expect(can(hk, 'housekeeping_readiness.clean', { assigneeStaffId: 'hk1' })).toBe(true)
    expect(can(hk, 'housekeeping_readiness.clean', { assigneeStaffId: 'hk2', siteId: 's1' })).toBe(false)
  })

  it('the table never gives a capability a global scope that could bypass sites', () => {
    for (const mod of Object.values(POLICY)) {
      for (const def of Object.values(mod.actions) as { caps?: Record<string, string> }[]) {
        for (const scope of Object.values(def.caps ?? {})) expect(scope).not.toBe('global')
      }
    }
  })

  it('every documented capability grants at least one action', () => {
    for (const cap of CAPABILITIES) {
      const holds = ALL_ACTIONS.some(a => can(actor('Res', { caps: [cap], sites: 'all', staffId: 'x' }), a) && !can(actor('Res', { caps: [], sites: 'all', staffId: 'x' }), a))
      expect(holds, cap).toBe(true)
    }
  })
})

describe('invariants of the matrix', () => {
  it('Read-only Manager and Auditor can only ever view or read reports', () => {
    for (const role of ['Mgr', 'Aud'] as const) {
      for (const action of ALL_ACTIONS) {
        if (!can(actor(role), action)) continue
        expect(action, `${role} holds ${action}`).toMatch(/\.(view|view_[a-z_]+)$/)
      }
    }
    expect(can(actor('Mgr'), 'reports_exports.export', { siteId: 's1' })).toBe(false)
    expect(can(actor('Aud'), 'reports_exports.export', { siteId: 's1' })).toBe(false)
  })

  it('no role holds a policy decision; Policy Approver is a capability only (D-25)', () => {
    for (const role of ROLES) expect(can(actor(role), 'requests_waitlist.approve_exception'), role).toBe(false)
    for (const role of ROLES) expect(can(actor(role), 'exit_clearance.waive'), role).toBe(false)
  })

  it('only the Super Admin changes roles and scope; only SA creates sites', () => {
    for (const role of ROLES) {
      expect(can(actor(role), 'users_roles.manage_roles_and_scope'), role).toBe(role === 'SA')
      expect(can(actor(role), 'sites_buildings.create_site'), role).toBe(role === 'SA')
    }
  })

  it('AA creates rooms and beds; Maintenance can block but not manage', () => {
    expect(can(actor('AA'), 'rooms_beds.manage', { siteId: 's1' })).toBe(true)
    expect(can(actor('MC'), 'rooms_beds.manage', { siteId: 's1' })).toBe(false)
    expect(can(actor('MC'), 'rooms_beds.block', { siteId: 's1' })).toBe(true)
  })

  it('migration import has separate maker and checker roles', () => {
    expect(can(actor('AA'), 'migration_import.prepare', { siteId: 's1' })).toBe(true)
    expect(can(actor('AA'), 'migration_import.signoff', { siteId: 's1' })).toBe(false)
    expect(can(actor('SA', { sites: 'all' }), 'migration_import.signoff', { siteId: 's1' })).toBe(true)
    expect(can(actor('SA', { sites: 'all' }), 'migration_import.prepare', { siteId: 's1' })).toBe(false)
  })

  it('exports are watermarked outage snapshots only with the OutageExport capability', () => {
    expect(can(actor('Rec'), 'reports_exports.export_outage', { siteId: 's1' })).toBe(false)
    expect(can(actor('Rec', { caps: ['OutageExport'] }), 'reports_exports.export_outage', { siteId: 's1' })).toBe(true)
  })
})

describe('scopeFilter turns a decision into a row restriction', () => {
  it('global grants and SA over all sites see every row', () => {
    expect(scopeFilter(actor('SA', { sites: 'all' }), 'rooms_beds.view')).toEqual({ kind: 'all' })
    expect(scopeFilter(actor('SA', { sites: ['s1'] }), 'system_config.view')).toEqual({ kind: 'all' })
  })

  it('site roles are limited to their sites', () => {
    expect(scopeFilter(actor('AA', { sites: ['s1', 's2'] }), 'rooms_beds.view')).toEqual({
      kind: 'restricted', siteIds: ['s1', 's2'], ownerStaffId: undefined, assigneeStaffId: undefined,
    })
  })

  it('residents and technicians are limited to their own / assigned rows', () => {
    expect(scopeFilter(actor('Res', { staffId: 'me' }), 'requests_waitlist.view')).toMatchObject({ kind: 'restricted', siteIds: [], ownerStaffId: 'me' })
    expect(scopeFilter(actor('Tech', { staffId: 't1' }), 'maintenance.view')).toMatchObject({ kind: 'restricted', siteIds: [], assigneeStaffId: 't1' })
  })

  it('combines a role scope and a capability scope, and never exceeds either', () => {
    const f = scopeFilter(actor('Rec', { sites: ['s1'], caps: ['Housekeeping'], staffId: 'h1' }), 'housekeeping_readiness.view')
    expect(f).toEqual({ kind: 'restricted', siteIds: ['s1'], ownerStaffId: undefined, assigneeStaffId: 'h1' })
  })

  it('is none when there is no grant, no sites, no staff record or the action is unknown', () => {
    expect(scopeFilter(actor('Tech'), 'rooms_beds.manage')).toEqual({ kind: 'none' })
    expect(scopeFilter(actor('AA', { sites: [] }), 'rooms_beds.view')).toEqual({ kind: 'none' })
    expect(scopeFilter(actor('Res', { staffId: undefined }), 'requests_waitlist.view')).toEqual({ kind: 'none' })
    expect(scopeFilter(actor('SA', { sites: 'all' }), 'nope.nope')).toEqual({ kind: 'none' })
  })
})

describe('the policy table mirrors docs/PERMISSIONS.md', () => {
  const md = readFileSync(path.resolve(process.cwd(), '../docs/PERMISSIONS.md'), 'utf8')
  const lines = md.split('\n')

  function table(headerStart: string): string[][] {
    const start = lines.findIndex(l => l.startsWith(headerStart))
    expect(start, `table "${headerStart}" not found in PERMISSIONS.md`).toBeGreaterThanOrEqual(0)
    const rows: string[][] = []
    for (let i = start; i < lines.length && lines[i].startsWith('|'); i++) {
      if (/^\|\s*-+/.test(lines[i])) continue
      rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()))
    }
    return rows
  }

  const matrix = table('| Module |')
  const header = matrix[0]
  const body = matrix.slice(1)

  it('lists the roles in the same order as ROLES', () => {
    expect(header.slice(1)).toEqual([...ROLES])
  })

  it('has at least the 20 module rows the matrix defined when this was written', () => {
    expect(body.length).toBeGreaterThanOrEqual(20)
  })

  it('every module row of the matrix exists in the policy table, and vice versa', () => {
    const labels = body.map(r => r[0]).sort()
    expect(Object.values(MODULE_LABELS).sort()).toEqual(labels)
  })

  it('a role marked "—" holds nothing in that module; any other cell (unless it is capability-gated "*") holds something', () => {
    const byLabel = new Map(Object.entries(MODULE_LABELS).map(([id, label]) => [label, id as ModuleId]))
    for (const row of body) {
      const moduleId = byLabel.get(row[0])!
      ROLES.forEach((role, i) => {
        const cell = row[i + 1]
        const holds = roleHoldsAnyInModule(role, moduleId)
        if (cell === '—') {
          expect(holds, `${row[0]} / ${role} is "—" in PERMISSIONS.md`).toBe(false)
        } else if (!cell.split(';').every(part => part.trim().endsWith('\\*'))) {
          expect(holds, `${row[0]} / ${role} is "${cell}" in PERMISSIONS.md`).toBe(true)
        }
      })
    }
  })

  it('every capability in the capabilities table exists, and no capability is invented', () => {
    const caps = table('| Capability |').slice(1).map(r => r[0])
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
    const matched = new Set<Capability>()
    for (const name of caps) {
      const hit = CAPABILITIES.find(c => norm(name).startsWith(norm(c)))
      expect(hit, `capability "${name}" has no match in CAPABILITIES`).toBeDefined()
      matched.add(hit!)
    }
    expect([...matched].sort()).toEqual([...CAPABILITIES].sort())
  })
})
