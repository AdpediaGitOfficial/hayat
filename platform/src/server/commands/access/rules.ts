/** Pure rules of user administration: no database, safe to import from the browser bundle as well. */
import type { Capability, Role, ScopeKind } from '@/domain/enums'

/** Roles that administer or oversee the system. Only a Super Admin creates, resets or deactivates such accounts (D-08). */
export const ADMIN_TYPE_ROLES: readonly Role[] = ['SA', 'AA', 'Mgr', 'Aud']

/** Which scope kinds make sense for which role. A building scope is allowed but gives NO site scope yet (S-6). */
export const ROLE_SCOPE_KINDS: Record<Role, readonly ScopeKind[]> = {
  SA: ['all'],
  AA: ['all', 'site', 'building'],
  Rec: ['all', 'site', 'building'],
  MC: ['all', 'site', 'building'],
  Sec: ['all', 'site', 'building'],
  Mgr: ['all', 'site', 'building'],
  Aud: ['all', 'site', 'building'],
  Res: ['own'],
  Tech: ['job'],
  Vend: ['job'],
}

export const SCOPE_LABEL: Record<ScopeKind, string> = {
  all: 'All sites', site: 'One site', building: 'One building (gives no site scope yet, S-6)', own: 'Own record only', job: 'Assigned jobs only',
}

/** Who typically holds a capability (docs/PERMISSIONS.md). A hint on screen, never enforced: the policy gives a capability to an actor of any role. */
export const CAPABILITY_HINT: Record<Capability, string> = {
  Housekeeping: 'A staff account, who may also be a Resident. Assigned rooms only, never their own.',
  FinalInspection: 'Typically Reception or an Accommodation Admin.',
  EmergencyCheckin: 'Typically Reception or an Accommodation Admin.',
  BuildingCreation: 'An Accommodation Admin, inside their own sites.',
  NightKeys: 'Security.',
  BackupApprover: 'A named user who decides escalated approvals.',
  PolicyApprover: 'An Accommodation Manager or HR Head.',
  OutageExport: 'Reception, on a declared outage.',
  StaffMaster: 'A non-AA user who keeps staff records.',
}
