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
import { waitlistSection } from '../app/(app)/waitlist/_components/MySection'
// <<< WP-E my imports
// >>> WP-H my imports
// <<< WP-H my imports
// >>> WP-I my imports
// <<< WP-I my imports
// >>> WP-F my imports
import { renderMyStay } from '../app/(app)/stays/_components/MyStay'
// <<< WP-F my imports

export interface MySection {
  id: string
  render: (cur: CurrentUser) => Promise<ReactNode | null>
}

export const MY_SECTIONS: readonly MySection[] = [
  // >>> WP-I my sections (keys I hold)
  // <<< WP-I my sections
  // >>> WP-F my sections (current stay, checkout)
  { id: 'stay', render: renderMyStay },
  // <<< WP-F my sections
  // >>> WP-E my sections (bed offer, waitlist)
  { id: 'waitlist', render: waitlistSection },
  // <<< WP-E my sections
  // >>> WP-D my sections (request, reservation)
  { id: 'requests', render: renderMyRequests },
  // <<< WP-D my sections
]
