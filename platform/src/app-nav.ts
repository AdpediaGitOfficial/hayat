/**
 * Navigation. An entry is shown only if the acting role may do at least one of its `actions` (no actions = everyone).
 * Hiding a menu entry is a convenience, never the control: every page and API still checks the policy itself.
 *
 * Each work package adds its entries inside its own marked block, and only there, so parallel changes merge cleanly.
 */
import type { Action } from '@/server/policy'
import type { IconName } from '@/ui/icons'

export interface NavItem {
  id: string
  label: string
  href: string
  icon: IconName
  group: string
  /** Visible if the actor may do ANY of these. Omitted = visible to every signed-in user. */
  actions?: readonly Action[]
}

export const NAV: readonly NavItem[] = [
  { id: 'home', label: 'Dashboard', href: '/', icon: 'dashboard', group: '' },
  // The resident's own accommodation (request, offer, reservation, stay). Residents only: Res is the only role with request_extension.
  { id: 'my', label: 'My accommodation', href: '/my', icon: 'home', group: '', actions: ['reservations_stays.request_extension'] },
  { id: 'notifications', label: 'Notifications', href: '/notifications', icon: 'bell', group: '' },

  // >>> WP-D nav (requests, approvals)
  // Approvals inbox: those who may decide something (SA, AA, MC, Auditor, Backup Approver, Policy Approver).
  { id: 'approvals', label: 'Approvals', href: '/approvals', icon: 'clipboard', group: 'Accommodation', actions: ['approvals_inbox.view'] },
  // Requests and reservations: staff roles that work with them (Reception, AA, SA, Manager, Auditor), not the Resident (who has My accommodation).
  { id: 'requests', label: 'Requests', href: '/requests', icon: 'list', group: 'Accommodation', actions: ['checkin_checkout.view'] },
  // The Policy Approver's report of exceptions and their uses (also Super Admin and Auditor).
  { id: 'exceptions', label: 'Exceptions', href: '/approvals/exceptions', icon: 'shield', group: 'Accommodation', actions: ['requests_waitlist.approve_exception', 'audit_log.view'] },
  // <<< WP-D nav

  // >>> WP-E nav (waitlist, offers)
  // Staff who act on the waitlist: the queue, offers in flight and priority decisions. Residents see their own entry and offers under "My accommodation".
  { id: 'waitlist', label: 'Waitlist', href: '/waitlist', icon: 'hourglass', group: 'Accommodation', actions: ['requests_waitlist.manage_waitlist', 'requests_waitlist.manage_offers', 'requests_waitlist.record_offline_offer', 'requests_waitlist.approve_exception'] },
  // <<< WP-E nav

  // >>> WP-F nav (stays, check-in, transfers)
  { id: 'stays', label: 'Stays & check-in', href: '/stays', icon: 'login', group: 'Accommodation', actions: ['checkin_checkout.view'] },
  // Transfers and swaps are reached from the Stays page (a second entry here would highlight both, the shell matches by path prefix).
  // <<< WP-F nav

  // >>> WP-G nav (emergency check-in)
  // Initiators (Emergency Check-in holders), approvers (AA, Backup and Policy Approvers) and viewers (SA, AA, Auditor).
  { id: 'emergency', label: 'Emergency check-in', href: '/emergency', icon: 'siren', group: 'Accommodation', actions: ['emergency_checkin.initiate', 'emergency_checkin.approve', 'emergency_checkin.view'] },
  // <<< WP-G nav

  // >>> WP-H nav (exit and clearance)
  // Cases and Mark as Left: SA, AA, Reception, Maintenance Coordinator, Manager, Auditor (each page narrows to what that role may do).
  { id: 'exits', label: 'Exits & clearance', href: '/exits', icon: 'clipboard', group: 'Accommodation', actions: ['exit_clearance.view'] },
  // <<< WP-H nav

  // >>> WP-I nav (keys and assets)
  // <<< WP-I nav

  // >>> WP-J nav (housekeeping and readiness)
  // <<< WP-J nav

  // >>> WP-A nav (property and inventory)
  // Sites & rooms: anyone who may view sites and buildings (SA, AA, Rec, MC, Sec, Mgr, Aud). Residents, technicians and contractors never see it.
  { id: 'sites', label: 'Sites & rooms', href: '/sites', icon: 'building', group: 'Accommodation', actions: ['sites_buildings.view'] },
  // <<< WP-A nav

  // >>> WP-B nav (staff)
  { id: 'staff', label: 'Staff', href: '/staff', icon: 'users', group: 'People', actions: ['staff_directory.view', 'staff_directory.lookup_minimum', 'staff_directory.identity_check'] },
  { id: 'my-profile', label: 'My profile', href: '/staff/me', icon: 'user', group: 'People', actions: ['staff_directory.view_own'] },
  // <<< WP-B nav

  // >>> WP-C nav (users, configuration, audit)
  { id: 'users', label: 'Users & access', href: '/users', icon: 'userCog', group: 'Administration', actions: ['users_roles.view'] },
  { id: 'config', label: 'Configuration', href: '/config', icon: 'settings', group: 'Administration', actions: ['system_config.view'] },
  { id: 'audit', label: 'Audit log', href: '/audit', icon: 'scroll', group: 'Administration', actions: ['audit_log.view'] },
  // <<< WP-C nav
]
