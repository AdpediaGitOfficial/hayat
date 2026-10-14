# Permission Matrix (corrected, v1.2)

Overrides `source/user-groups-draft.md`. Every cell is further limited by the user's assigned site/building, job or own-record scope. Enforced server-side.

SA = Super Admin · AA = Accommodation Admin · Rec = Reception/Officer · Res = Resident · MC = Maintenance Coordinator · Tech = Technician · Vend = Vendor/Contractor · Sec = Security · Mgr = Read-only Manager · Aud = Auditor
— = no access · \* = only with an explicit capability grant

| Module | SA | AA | Rec | Res | MC | Tech | Vend | Sec | Mgr | Aud |
|---|---|---|---|---|---|---|---|---|---|---|
| Users & roles | Full | Staff accounts (own sites) | — | Own contact fields | — | — | — | — | — | Audit |
| Sites & buildings | Full | View; create building\* | View | — | View | — | — | Gate view | View | Audit |
| Rooms & beds | Full | Manage | View + readiness | Own bed | View; block | Job location | Job location | — | View | Audit |
| Staff directory & eligibility | Full | Manage + CSV | Lookup (minimum data) | Own status | — | — | — | Identity check only | — | Audit |
| Requests, waitlist, offers | Full | Manage | Submit on behalf; record offline offer; accept on behalf (consent) | Own; accept/decline | — | — | — | — | Summary | Audit |
| Reservations, stays, extensions | Full | Manage / approve | Process | Own; request extension / checkout | — | — | — | — | Summary | Audit |
| Check-in / check-out (incl. bulk) | Full | Execute | Execute | — | — | — | — | — | Summary | Audit |
| Emergency check-in | Config | Approve (not own); initiate\* | Initiate\* | — | — | — | — | — | — | Audit |
| Transfers & swaps | Full | Manage / approve | Execute approved | Request | — | — | — | — | Summary | Audit |
| Exit & clearance | Full | Mark Left; manage case | Clearance tasks | — | Inspection items | — | — | — | Summary | Audit |
| Keys | Full | Manage | Issue / return | Own keys | — | — | — | Night keys\* | — | Audit |
| Housekeeping & readiness | Full | Mark ready\* | Assign; final inspection\* | — | Block / unblock | — | — | — | Summary | Audit |
| Maintenance / work orders | Full | View | Create | Create own | Manage; verify | Assigned | Assigned | — | Summary | Audit |
| Visitors & gate passes | Full | Manage\* | Register | Own requests\* | Contractor access | — | Own pass | Verify; gate in/out | Summary | Audit |
| Incidents & SOS | Full | View; escalation | Record | Raise SOS / incident | — | Report | Report | Acknowledge; respond; close | Summary | Audit |
| Approvals inbox | Config + system escalations | Approve per route | — | — | Work-order routes | — | — | — | — | Audit |
| Reports & exports | Full | Own sites | Arrivals/departures; outage export\* | Own | Maintenance | Own jobs | Own jobs | Gate / incident | Operational; export\* | Audit exports |
| Audit log | View | Own sites\* | — | — | — | — | — | — | — | Full view |
| System configuration | Full | Checklists / templates\* | — | — | — | — | — | — | — | — |
| Migration import | Sign-off (checker) | Prepare (maker) | — | — | — | — | — | — | — | Audit |

## Capabilities (added on top of a group; never widen scope)

| Capability | Typical holder | Allows |
|---|---|---|
| Housekeeping | Staff account (may also be a Resident) | Assigned rooms, cleaning checklist, report issue. Never their own room. |
| Final Inspection | Rec / AA | Move a bed from Needs Cleaning/Inspection to Available |
| Emergency Check-in | Rec / AA | Create a provisional stay |
| Building Creation | AA | Create buildings within assigned sites |
| Night Keys | Sec | Issue/return keys out of hours |
| Backup Approver | Named user | Decide escalated provisional stays / routed approvals |
| Policy Approver | Accommodation Manager / HR Head | Policy & exception decisions (gender/grade, beyond-policy extension, waitlist priority, clearance waiver) |
| Outage Export | Rec | Watermarked arrivals/departures snapshot |
| Staff Master / HR | Non-AA user | Staff records, CSV import, eligibility |

## Rules
- Resident is a base role; operational roles add on top. A user switches between "My stay" and "My work".
- Only SA changes a user's site/building scope. Grants and role changes use maker-checker.
- Separation of duties per DECISIONS.md D-26, enforced in the API.
- Left staff: login revoked immediately; history visible to authorised staff.


## Proposed changes, pending client sign-off (see DECISIONS.md section 15)

These are not part of the approved matrix. The policy table carries the entries so the switch can be turned on without a deployment; each command also checks its setting, so with the setting off the matrix above is exactly what is enforced.

| Row | Role | Proposed addition | Setting | Ships |
|---|---|---|---|---|
| Transfers & swaps | Reception | Raise a request on a resident's behalf (still never approve) | `transfers.reception_may_raise` (P-09) | OFF |
| Keys | Resident | Report an own held key lost | `keys.resident_may_report_lost` (P-05) | OFF |
| Requests, transfers, extensions | Policy Approver, Backup Approver | Decide once the item reaches the backup level of the approval clock (APPROVALS.md) | `approvals.escalation_backup` (P-01) | ON |
| Transfers & swaps | Policy Approver | Grant an eligibility exception for one transfer destination | `transfers.exception_path` (P-10) | ON |
