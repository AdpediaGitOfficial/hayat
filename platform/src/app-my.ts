/**
 * "My accommodation" (/my): the resident's own journey, composed of sections that each work package provides.
 * A section is a server-side function returning what to show for this person (or null for nothing). Each package
 * adds one import and one array entry inside its own marked blocks, so parallel work merges cleanly.
 */
import type { ReactNode } from 'react'
import type { CurrentUser } from '@/server/auth/current'

// >>> WP-D my imports
// <<< WP-D my imports
// >>> WP-E my imports
// <<< WP-E my imports
// >>> WP-F my imports
import { renderMyStay } from '../app/(app)/stays/_components/MyStay'
// <<< WP-F my imports

export interface MySection {
  id: string
  render: (cur: CurrentUser) => Promise<ReactNode | null>
}

export const MY_SECTIONS: readonly MySection[] = [
  // >>> WP-F my sections (current stay, checkout)
  { id: 'stay', render: renderMyStay },
  // <<< WP-F my sections
  // >>> WP-E my sections (bed offer, waitlist)
  // <<< WP-E my sections
  // >>> WP-D my sections (request, reservation)
  // <<< WP-D my sections
]
