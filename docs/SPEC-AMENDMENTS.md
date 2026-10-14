# Proposed amendments for SRS v1.2

Source for the merge of the decision log into the specification. Each row replaces text in the Full Project Document v1.1 (FPD) so that it agrees with `DECISIONS.md`. Conflict numbers (C-x) and gap numbers (G-xx) are from `GAP-ANALYSIS.md`. Nothing here is new policy: where a row needs a Grand Hyatt answer it says so.

## A. Wording that conflicts with the decision log

| Ref | FPD location | Replace with |
|---|---|---|
| C-1 | §21 rows "Waitlist priority exception", "Extension beyond policy", "Gender/grade exception", and the Backup column of most rows | Primary approver is the **Policy Approver** (business authority, D-25). Super Admin remains the final *system* escalation. |
| C-2 | §4 intro, §5.1 | "Site → Building → [Floor] → [Unit] → Room → Bed. Floor and Unit are optional (D-12)." |
| C-3 | §6, Stay row | "Active → Checkout Due → Checked Out → Closed. A Stay begins at check-in. Before that there is a Reservation (separate record, D-43)." |
| C-4 | §6, Bed row; §14 occupancy report | "Bed physical state: Available, Occupied, Needs Cleaning, Inspection Required, Blocked, Under Maintenance, Archived. Reservations are date-ranged records shown alongside (D-17). Reports derive 'Reserved' from reservations." |
| C-5 | §21 "Bed allocation/reservation execution" | Delete the row. "Approval of a standard request selects the bed and creates the reservation in one atomic step (D-44). Reception executes check-in." |
| C-6 | §11 "Bed state", AT-021 | §11: "Blocked, archived, under-maintenance and occupied beds cannot be allocated. Beds that are not ready can carry a reservation for a later date; they cannot be checked into or offered until readiness passes (D-18)." AT-021 expected result: "Bed remains Needs Cleaning/Inspection and **cannot be checked into or offered**." |
| C-7 | §8 Escalation row, AT-016, §21 emergency rows | "Reception-initiated: Accommodation Admin (not the initiator) decides. AA-initiated: Policy Approver. Escalation after two unanswered reminders goes to the backup approver, then the Policy Approver or Super Admin (D-68)." |
| C-8 | §4.1 | Delete the 30-day restore and Super Admin hard-delete text. "No deletion of any kind (D-40). An audited anonymisation procedure is added only if Grand Hyatt legal requires one (G-27)." |
| C-9 | §3.1 | Capability list: Housekeeping, Final Inspection, Emergency Check-in, Building Creation, Night Keys, Backup Approver, Policy Approver, Outage Export, Staff Master / HR, Report Export. Remove key, inventory and facility supervisors (D-11, G-24). |
| C-10 | §5.3 step 14 | Delete "if any". "No request category is auto-approved in Phase 1 (D-45)." |
| D-103 | §4 data model, §5.3, §5.4, §6 | "Reservation and stay dates are arrival day and **departure day** (end-exclusive). A bed is held for the nights from arrival up to the departure day, so same-day turnover is allowed and two claims overlap only if they share a night." Bed blocks use the last blocked day. |
| — | §20 Housekeeping row, AA column | "Mark ready" becomes "Mark ready, with the Final Inspection capability (D-24)". |

## B. New text the gap analysis calls for (proposed defaults, pending confirmation)

| Ref | Add to | Text |
|---|---|---|
| G-01 | §15 | NFR-14: Each site has a time zone, a working week (default Mon–Fri) and a holiday list. "Business day", "no-show" and overdue rules use the site calendar. |
| G-02 | §21 | In-flight approvals keep the route version they started under. Deactivating an approver first reassigns their pending items. |
| G-03 | §2.1 | Approval routes are fixed route types with configurable named approvers, SLAs and delegation. No visual workflow designer in Phase 1. |
| G-04 | §3.2, §21 | A delegate takes the approver's place for the dated range. Separation of duties applies to the delegate personally. Delegations are audited. |
| G-05 | §4 StaffProfile | Optional photo uploaded by the Accommodation Admin. No identity-document numbers are stored. Security sees name, photo and room only. |
| G-06 | §10.1 | Add the notification catalogue (event × recipient × channel × timing × dedupe key) as an appendix. |
| G-07 | §7 | An offer's 48h clock starts on: viewed in the app, email delivery confirmed by the provider's receipt, or documented offline follow-up. "Accepted by provider" never starts the clock. |
| G-08 | AT-005 | "Valid rows save once; rejected rows download with reasons." The administrator chooses valid-rows-only (default) or all-or-nothing at confirm time. |
| G-09 | §14 | Occupancy = occupied beds ÷ active beds. Reports also show "ready and vacant" and "out of service". |
| G-11 | NFR-07 | Placeholders: invitation link 72h; lock 15 min after 5 failed sign-ins; admin session idle 30 min, resident 12 h. Grand Hyatt to set (GH-14). |
| G-18 | NFR-10 | Planning basis: ≤ 1,500 residents, ≤ 50 concurrent users, 99.5% availability, RPO 15 min, RTO 4 h, current and previous two versions of Chrome, Edge, Safari and Firefox. |
| G-20 | §15 | NFR-13: WCAG 2.1 AA. |
| G-21 | §15 | NFR-15: English in Phase 1; all text held in message catalogues so languages can be added. |

## C. Test changes

| AT | Change |
|---|---|
| AT-021 | Reworded per C-6. |
| AT-005 | Reworded per G-08. |
| AT-014 | Add: "provider 'accepted' is not shown as 'delivered'; a failed critical alert surfaces on the admin dashboard." |
| AT-017 | Add the delegate case: a delegate cannot approve their own request. |
| New AT-033 | Delegation routes approvals to the delegate for the dates only, and expires. |
| New AT-034 | A capability grant, role change or scope change takes effect only after a different Super Admin approves; time-limited grants expire. |
| New AT-035 | Blocking a room or building stops new allocations to every descendant bed and flags occupants without moving them. |
