/**
 * Policy module: Module x Action x Scope, deny by default (PLAN section 6).
 *
 * Every route handler, server action, report and export must call can()/decide() and apply scopeFilter()
 * to its queries. Out-of-scope reads should surface as "not found", not "forbidden" (AT-002), which is why
 * decide() tells the two refusals apart.
 *
 * POLICY mirrors docs/PERMISSIONS.md. tests/server/policy.test.ts parses that file and fails if a module row
 * is missing here, or if a role marked "—" in the matrix holds any role-level grant in this table.
 *
 * Rules baked in:
 *  - a role grant or capability grant adds ACTIONS; scope always comes from the actor's own sites/staffId (D-22),
 *  - SA is the only role whose actors normally carry sites = 'all'; the table itself never widens scope,
 *  - separation of duties (D-26: nobody acts on their own record) is NOT decided here. It needs the record,
 *    so it runs inside each command, after can().
 */
import type { Capability, Role } from '@/domain/enums'

/**
 * How a grant limits the rows it applies to:
 *  site   - the resource's site must be one of the actor's assigned sites ('all' for SA-type actors)
 *  own    - the resource is about the actor's own staff record (resource.ownerStaffId)
 *  job    - the resource is assigned to the actor (resource.assigneeStaffId): technician, contractor, housekeeper
 *  global - not tied to a site (system-wide configuration)
 */
export type Scope = 'site' | 'own' | 'job' | 'global'

interface ActionDef {
  /** Grants held by the role itself. */
  roles: Partial<Record<Role, Scope>>
  /** Extra holders: an actor of ANY role carrying the capability. Never changes the scope an actor has. */
  caps?: Partial<Record<Capability, Scope>>
}
interface ModuleDef { label: string; actions: Record<string, ActionDef> }

/* The label of each module is the first-column text of docs/PERMISSIONS.md, verbatim. */
export const POLICY = {
  users_roles: {
    label: 'Users & roles',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Aud: 'site' } },
      manage_staff_accounts: { roles: { SA: 'site', AA: 'site' } },
      manage_roles_and_scope: { roles: { SA: 'global' } },           // maker-checker (D-27)
      approve_grant: { roles: { SA: 'global' } },                    // the checker; a different SA than the maker
      update_own_contact: { roles: { Res: 'own' } },
    },
  },
  sites_buildings: {
    label: 'Sites & buildings',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', MC: 'site', Sec: 'site', Mgr: 'site', Aud: 'site' } },
      manage: { roles: { SA: 'site' } },
      create_site: { roles: { SA: 'global' } },
      create_building: { roles: { SA: 'site' }, caps: { BuildingCreation: 'site' } },
    },
  },
  rooms_beds: {
    label: 'Rooms & beds',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', MC: 'site', Mgr: 'site', Aud: 'site', Res: 'own', Tech: 'job', Vend: 'job' } },
      manage: { roles: { SA: 'site', AA: 'site' } },                 // AA creates rooms and beds; archive only
      block: { roles: { SA: 'site', AA: 'site', MC: 'site' } },
    },
  },
  staff_directory: {
    label: 'Staff directory & eligibility',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Aud: 'site' }, caps: { StaffMaster: 'site' } },
      lookup_minimum: { roles: { Rec: 'site' } },
      identity_check: { roles: { Sec: 'site' } },
      view_own: { roles: { Res: 'own' } },
      manage: { roles: { SA: 'site', AA: 'site' }, caps: { StaffMaster: 'site' } },
      import_csv: { roles: { SA: 'site', AA: 'site' }, caps: { StaffMaster: 'site' } },
    },
  },
  requests_waitlist: {
    label: 'Requests, waitlist, offers',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Mgr: 'site', Aud: 'site', Res: 'own' } },
      submit: { roles: { SA: 'site', AA: 'site', Rec: 'site', Res: 'own' } },        // Rec: on behalf of staff
      approve: { roles: { SA: 'site', AA: 'site' } },
      approve_exception: { roles: {}, caps: { PolicyApprover: 'site' } },            // D-25: gender/grade, waitlist priority
      manage_waitlist: { roles: { SA: 'site', AA: 'site' } },
      manage_offers: { roles: { SA: 'site', AA: 'site' } },
      record_offline_offer: { roles: { Rec: 'site' } },
      accept_offer_on_behalf: { roles: { Rec: 'site' } },                            // with the resident's consent
      respond_offer: { roles: { Res: 'own' } },
    },
  },
  reservations_stays: {
    label: 'Reservations, stays, extensions',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Mgr: 'site', Aud: 'site', Res: 'own' } },
      manage: { roles: { SA: 'site', AA: 'site' } },
      process: { roles: { Rec: 'site' } },
      approve_extension: { roles: { SA: 'site', AA: 'site' } },
      approve_extension_beyond_policy: { roles: {}, caps: { PolicyApprover: 'site' } },
      request_extension: { roles: { Res: 'own' } },
      request_checkout: { roles: { Res: 'own' } },
    },
  },
  checkin_checkout: {
    label: 'Check-in / check-out (incl. bulk)',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Mgr: 'site', Aud: 'site' } },
      execute: { roles: { SA: 'site', AA: 'site', Rec: 'site' } },
      allocate_bulk: { roles: { SA: 'site', AA: 'site' } },
    },
  },
  emergency_checkin: {
    label: 'Emergency check-in',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Aud: 'site' } },
      configure: { roles: { SA: 'global' } },
      approve: { roles: { AA: 'site' }, caps: { BackupApprover: 'site', PolicyApprover: 'site' } },   // never one's own (D-26)
      initiate: { roles: {}, caps: { EmergencyCheckin: 'site' } },
    },
  },
  transfers_swaps: {
    label: 'Transfers & swaps',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Mgr: 'site', Aud: 'site', Res: 'own' } },
      approve: { roles: { SA: 'site', AA: 'site' } },
      execute: { roles: { SA: 'site', AA: 'site', Rec: 'site' } },                   // Rec: approved ones only
      request: { roles: { Res: 'own' } },
    },
  },
  exit_clearance: {
    label: 'Exit & clearance',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', MC: 'site', Mgr: 'site', Aud: 'site' } },
      mark_left: { roles: { SA: 'site', AA: 'site' } },
      manage_case: { roles: { SA: 'site', AA: 'site' } },
      clearance_task: { roles: { SA: 'site', AA: 'site', Rec: 'site' } },
      inspection_item: { roles: { MC: 'site' } },
      waive: { roles: {}, caps: { PolicyApprover: 'site' } },
    },
  },
  keys: {
    label: 'Keys',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Aud: 'site', Res: 'own' } },
      manage: { roles: { SA: 'site', AA: 'site' } },
      issue_return: { roles: { Rec: 'site' } },
      issue_return_night: { roles: {}, caps: { NightKeys: 'site' } },
    },
  },
  housekeeping_readiness: {
    label: 'Housekeeping & readiness',
    actions: {
      view: { roles: { SA: 'site', Rec: 'site', MC: 'site', Mgr: 'site', Aud: 'site' }, caps: { Housekeeping: 'job' } },
      manage: { roles: { SA: 'site' } },
      assign: { roles: { SA: 'site', Rec: 'site' } },
      clean: { roles: {}, caps: { Housekeeping: 'job' } },                           // assigned rooms, never one's own (D-26)
      final_inspection: { roles: {}, caps: { FinalInspection: 'site' } },
      mark_ready: { roles: {}, caps: { FinalInspection: 'site' } },
      block_unblock: { roles: { SA: 'site', MC: 'site' } },
    },
  },
  maintenance: {
    label: 'Maintenance / work orders',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', MC: 'site', Mgr: 'site', Aud: 'site', Tech: 'job', Vend: 'job' } },
      create: { roles: { SA: 'site', Rec: 'site', MC: 'site', Res: 'own' } },
      manage: { roles: { SA: 'site', MC: 'site' } },
      verify: { roles: { SA: 'site', MC: 'site' }, caps: { BackupApprover: 'site' } },
      work_assigned: { roles: { Tech: 'job', Vend: 'job' } },
    },
  },
  visitors_gate: {
    label: 'Visitors & gate passes',
    actions: {
      view: { roles: { SA: 'site', Sec: 'site', Mgr: 'site', Aud: 'site', Vend: 'own' } },
      manage: { roles: { SA: 'site' } },                                             // AA only with a grant (not yet defined, see README)
      register: { roles: { SA: 'site', Rec: 'site' } },
      contractor_access: { roles: { SA: 'site', MC: 'site' } },
      gate_verify: { roles: { Sec: 'site' } },
      gate_in_out: { roles: { Sec: 'site' } },
    },
  },
  incidents_sos: {
    label: 'Incidents & SOS',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Rec: 'site', Sec: 'site', Mgr: 'site', Aud: 'site' } },
      escalate: { roles: { SA: 'site', AA: 'site' } },
      record: { roles: { SA: 'site', Rec: 'site' } },
      raise: { roles: { Res: 'own', Tech: 'job', Vend: 'job' } },                    // SOS / incident report
      acknowledge: { roles: { SA: 'site', Sec: 'site' } },                           // 5-minute SOS acknowledgement
      respond_close: { roles: { SA: 'site', Sec: 'site' } },
    },
  },
  approvals_inbox: {
    label: 'Approvals inbox',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', MC: 'site', Aud: 'site' }, caps: { BackupApprover: 'site', PolicyApprover: 'site' } },
      configure: { roles: { SA: 'global' } },
      decide_route: { roles: { AA: 'site' } },
      decide_workorder_route: { roles: { MC: 'site' } },
      decide_escalated: { roles: {}, caps: { BackupApprover: 'site', PolicyApprover: 'site' } },
    },
  },
  reports_exports: {
    label: 'Reports & exports',
    actions: {
      view_operational: { roles: { SA: 'site', AA: 'site', Mgr: 'site' } },
      view_arrivals_departures: { roles: { SA: 'site', AA: 'site', Rec: 'site' } },
      view_maintenance: { roles: { SA: 'site', MC: 'site' } },
      view_gate_incident: { roles: { SA: 'site', Sec: 'site' } },
      view_own: { roles: { Res: 'own', Tech: 'job', Vend: 'job' } },
      export: { roles: { SA: 'site', AA: 'site' } },
      export_outage: { roles: {}, caps: { OutageExport: 'site' } },                  // watermarked, audited (D-90)
      view_export_audit: { roles: { SA: 'site', Aud: 'site' } },
    },
  },
  audit_log: {
    label: 'Audit log',
    actions: {
      view: { roles: { SA: 'site', Aud: 'site' } },                                  // AA own sites: only with a grant (not yet defined)
    },
  },
  system_config: {
    label: 'System configuration',
    actions: {
      view: { roles: { SA: 'global' } },
      manage: { roles: { SA: 'global' } },
    },
  },
  migration_import: {
    label: 'Migration import',
    actions: {
      view: { roles: { SA: 'site', AA: 'site', Aud: 'site' } },
      prepare: { roles: { AA: 'site' } },                                            // maker
      signoff: { roles: { SA: 'site' } },                                            // checker; never the maker
    },
  },
} as const satisfies Record<string, ModuleDef>

type Policy = typeof POLICY
export type ModuleId = keyof Policy
export type Action = { [M in ModuleId]: `${M}.${Extract<keyof Policy[M]['actions'], string>}` }[ModuleId]

/* ---------------- evaluation ---------------- */

export interface Actor {
  role: Role
  /** Active capability grants only (approved by the checker, started, not expired). The session layer filters. */
  caps: readonly Capability[]
  /** Assigned sites, or 'all'. Only a Super Admin changes this (D-22). */
  sites: readonly string[] | 'all'
  /** The actor's own staff record, when they have one. */
  staffId?: string
}

/** What the action is being done to. Fields the caller leaves out can never satisfy a scope that needs them. */
export interface Resource {
  siteId?: string
  /** The staff member the record is about (their stay, their request, their keys). */
  ownerStaffId?: string
  /** The staff member the record is assigned to (job, cleaning task). */
  assigneeStaffId?: string
}

export type Decision =
  | { allowed: true; via: 'role' | Capability; scope: Scope }
  | { allowed: false; reason: 'unknown_action' | 'no_grant' | 'out_of_scope' }

function lookup(action: string): ActionDef | undefined {
  const dot = action.indexOf('.')
  if (dot < 1) return undefined
  const mod = action.slice(0, dot)
  const act = action.slice(dot + 1)
  // hasOwn: an attacker-controlled "constructor" or "__proto__" must not resolve to something on Object.prototype.
  if (!Object.hasOwn(POLICY, mod)) return undefined
  const actions = (POLICY as Record<string, ModuleDef>)[mod].actions
  return Object.hasOwn(actions, act) ? actions[act] : undefined
}

interface Candidate { via: 'role' | Capability; scope: Scope }
function candidates(def: ActionDef, actor: Actor): Candidate[] {
  const out: Candidate[] = []
  if (Object.hasOwn(def.roles, actor.role)) out.push({ via: 'role', scope: def.roles[actor.role]! })
  const seen = new Set<string>()
  for (const cap of actor.caps) {
    if (seen.has(cap)) continue
    seen.add(cap)
    if (def.caps && Object.hasOwn(def.caps, cap)) out.push({ via: cap, scope: def.caps[cap]! })
  }
  return out
}

function inScope(scope: Scope, actor: Actor, r: Resource): boolean {
  switch (scope) {
    case 'global': return true
    case 'site': return r.siteId !== undefined && (actor.sites === 'all' || actor.sites.includes(r.siteId))
    case 'own': return actor.staffId !== undefined && r.ownerStaffId === actor.staffId
    case 'job': return actor.staffId !== undefined && r.assigneeStaffId === actor.staffId
    default: return false
  }
}

/**
 * Full decision with the reason for a refusal. Without a resource this answers "may this actor ever do this?"
 * (e.g. to show a menu entry or to start a list query); the caller must then narrow rows with scopeFilter().
 */
export function decide(actor: Actor, action: Action | (string & {}), resource?: Resource): Decision {
  const def = lookup(action)
  if (!def) return { allowed: false, reason: 'unknown_action' }
  const cands = candidates(def, actor)
  if (cands.length === 0) return { allowed: false, reason: 'no_grant' }
  if (resource === undefined) return { allowed: true, via: cands[0].via, scope: cands[0].scope }
  const hit = cands.find(c => inScope(c.scope, actor, resource))
  return hit ? { allowed: true, via: hit.via, scope: hit.scope } : { allowed: false, reason: 'out_of_scope' }
}

export function can(actor: Actor, action: Action | (string & {}), resource?: Resource): boolean {
  return decide(actor, action, resource).allowed
}

/**
 * Row restriction for list queries and exports. Repositories translate this into a WHERE clause
 * (site_id = ANY(siteIds) OR owner = ownerStaffId OR assignee = assigneeStaffId), so out-of-scope rows are
 * never fetched. 'none' means the actor may not see any row.
 */
export type ScopeFilter =
  | { kind: 'none' }
  | { kind: 'all' }
  | { kind: 'restricted'; siteIds: readonly string[]; ownerStaffId?: string; assigneeStaffId?: string }

export function scopeFilter(actor: Actor, action: Action | (string & {})): ScopeFilter {
  const def = lookup(action)
  if (!def) return { kind: 'none' }
  let siteIds: readonly string[] = []
  let ownerStaffId: string | undefined
  let assigneeStaffId: string | undefined
  for (const c of candidates(def, actor)) {
    if (c.scope === 'global') return { kind: 'all' }
    if (c.scope === 'site') {
      if (actor.sites === 'all') return { kind: 'all' }
      siteIds = [...new Set([...siteIds, ...actor.sites])]
    } else if (c.scope === 'own' && actor.staffId) ownerStaffId = actor.staffId
    else if (c.scope === 'job' && actor.staffId) assigneeStaffId = actor.staffId
  }
  if (siteIds.length === 0 && !ownerStaffId && !assigneeStaffId) return { kind: 'none' }
  return { kind: 'restricted', siteIds, ownerStaffId, assigneeStaffId }
}

/* ---------------- introspection (contract tests, menu building) ---------------- */

export const ALL_ACTIONS: readonly Action[] = (Object.keys(POLICY) as ModuleId[]).flatMap(m =>
  Object.keys(POLICY[m].actions).map(a => `${m}.${a}` as Action),
)

export const MODULE_LABELS: Readonly<Record<ModuleId, string>> = Object.fromEntries(
  (Object.keys(POLICY) as ModuleId[]).map(m => [m, POLICY[m].label]),
) as Record<ModuleId, string>

/** Does the ROLE ITSELF (ignoring capabilities) hold any action in this module? Used by the PERMISSIONS.md mirror test. */
export function roleHoldsAnyInModule(role: Role, module: ModuleId): boolean {
  return Object.values(POLICY[module].actions).some(a => Object.hasOwn(a.roles, role))
}
