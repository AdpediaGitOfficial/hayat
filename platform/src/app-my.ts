/**
 * "My accommodation" (/my): the resident's own journey, composed of sections that each work package provides.
 * A section is a server-side function returning what to show for this person (or null for nothing). Each package
 * adds one import and one array entry inside its own marked blocks, so parallel work merges cleanly.
 */
import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current'

// >>> WP-D my imports
import { renderMyRequests } from '../app/(app)/requests/_components/MySection'
// <<< WP-D my imports
// >>> WP-E my imports
// <<< WP-E my imports
// >>> WP-F my imports
// <<< WP-F my imports

export interface MySection {
  id: string
  render: (cur: CurrentUser) => Promise<ReactNode | null>
}

export const MY_SECTIONS: readonly MySection[] = [
  // >>> WP-F my sections (current stay, checkout)
  // <<< WP-F my sections
  // >>> WP-E my sections (bed offer, waitlist)
  // <<< WP-E my sections
  // >>> WP-D my sections (request, reservation)
  { id: 'requests', render: renderMyRequests },
  // <<< WP-D my sections
]
