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

  // >>> WP-A nav (property and inventory)
  // <<< WP-A nav

  // >>> WP-B nav (staff)
  // <<< WP-B nav

  // >>> WP-C nav (users, configuration, audit)
  { id: 'users', label: 'Users & access', href: '/users', icon: 'userCog', group: 'Administration', actions: ['users_roles.view'] },
  { id: 'config', label: 'Configuration', href: '/config', icon: 'settings', group: 'Administration', actions: ['system_config.view'] },
  { id: 'audit', label: 'Audit log', href: '/audit', icon: 'scroll', group: 'Administration', actions: ['audit_log.view'] },
  // <<< WP-C nav
]
