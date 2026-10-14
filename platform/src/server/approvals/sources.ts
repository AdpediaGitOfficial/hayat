/**
 * Importing this file registers every approval source. Each work package adds ONE import inside its own marked block.
 */

// >>> WP-D approval sources (requests, exceptions)
import '@/server/commands/approvals/sources'
// <<< WP-D approval sources

// >>> WP-E approval sources (waitlist priority, renewal)
import '../commands/waitlist/source'
// <<< WP-E approval sources

// >>> WP-F approval sources (transfers, swaps, extensions)
import '@/server/commands/stays/approvalSources'
// <<< WP-F approval sources

// >>> WP-G approval sources (emergency)
import '@/server/queries/emergency/approvalSource'
// <<< WP-G approval sources

export {}
