/**
 * Importing this file registers every sweep. Each work package adds ONE import inside its own marked block.
 */
import '../../approvals/sweep'

// >>> WP-D sweeps
import './requests'
// <<< WP-D sweeps

// >>> WP-E sweeps (waitlist, offers)
import './waitlist'
// <<< WP-E sweeps

// >>> WP-F sweeps (no-show, end-date, overdue)
import './stays'
// <<< WP-F sweeps

// >>> WP-H sweeps (clearance overdue)
// <<< WP-H sweeps

// >>> WP-I sweeps (keys overdue)
// <<< WP-I sweeps

// >>> WP-J sweeps (cleaning reminders)
import './readiness'
// <<< WP-J sweeps

// >>> WP-G sweeps (emergency)
import './emergency'
// <<< WP-G sweeps
