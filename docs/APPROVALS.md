# Approval Routes (v1.2)

Builds on `source/approval-tree-v1.1.md` and adds the review changes from 14 Oct: Policy Approver, the missing routes, timing and delegation.

Principles: no auto-approval/rejection/move/checkout on timeout · no self-approval (auto-route to an independent approver) · grants never widen scope · every decision records actor, timestamp, decision, reason, before/after state.

PA = Policy Approver (business authority; D-25). Where v1.1 named SA as a business approver, PA replaces it. SA remains final *system* escalation.

| Request / action | Primary | Backup / escalation | Target | Notes |
|---|---|---|---|---|
| Standard accommodation request | AA | PA | 2 business days (Urgent flag if arrival inside SLA) | Approval selects the bed and creates the reservation atomically; Rec executes check-in |
| Waitlist priority exception | PA | Named backup | 2 business days | Reason + evidence; queue history kept |
| Waitlist renewal | AA | PA | Before expiry | Revalidate eligibility |
| Bed offer acceptance | Resident (no staff approval) | AA for disputes | 48h from confirmed delivery | Not viewed in 24h → Rec follow-up; accept on behalf with consent |
| Bulk allocation | AA (preview = approval) | PA | — | Per-row results; retry-safe |
| Stay extension within policy | AA | PA | 2 business days | Conflict with next booking → offer transfer |
| Extension beyond policy | PA | Named backup | 2 business days | Reason mandatory |
| No-show extension / staff cancellation | AA | PA | — | Reason required |
| Voluntary checkout | No approval; Rec processes | AA for disputes | Acknowledge 1 business day | Overdue departures escalate |
| Mark as Left | AA (action) | — | Same business day | Re-confirm; notify PA; bulk needs preview |
| Clearance waiver | PA | Named backup | — | Reason + evidence |
| Rehire / reactivation | AA | PA if old clearance open | — | Same profile; no duplicate |
| Transfer within policy | AA | PA | 2 business days | Rec executes; atomic |
| Swap | AA | PA | 2 business days | Single atomic two-way operation |
| Gender / grade eligibility exception | PA | Named backup | Before allocation | All uses reported |
| Emergency check-in (Rec-initiated) | AA (not initiator) | Backup approver → PA/SA | 24h; re-alert every 24h; escalate after 2 unanswered | Never auto-approve/checkout |
| Emergency check-in (AA-initiated) | PA | Named backup | Same | Initiator can't approve |
| Emergency rejection follow-up | AA owns relocation/checkout task | PA | Deadline per GH-07 | Never auto-move |
| Room/bed block, unblock, capacity change | AA | PA | — | Reduction below occupancy blocked |
| Migration import | AA prepares (maker) | PA or SA signs off (checker) | Before production | Stays tagged Migrated |
| Work order assignment | MC | AA (cross-site) | 1 business day triage | |
| Work completion verification | MC / independent verifier | AA | 2 business days | Tech/contractor can't self-verify |
| Readiness after cleaning | Final Inspection holder | AA / PA dispute | Before Available | Cleaner can't inspect own room |
| Visitor needing approval | Rec | AA | Before arrival | Security records gate |
| Contractor access / gate pass | MC (job) or AA (accommodation) | SA | Before arrival | |
| Night key issue/return | Sec (Night Keys) | AA | Each event | Missing key → AA |
| SOS / serious incident | Sec acknowledges & responds; AA coordinates | PA / emergency contact by severity | Ack within 5 min (default) | Never waits on approval; night roster needed |
| Role/permission change; capability grant | Independent SA (maker-checker) | Second SA / governance approver | Before effect | Last SA protected |
| Workflow publish / bulk archive / retention change | Independent SA | Second SA / governance approver | Before effect | No hard delete |
| Password reset / unlock | AA (staff), SA (admins) | — | — | Admin-assisted |
| Outage export | Rec (Outage Export) | AA | On declared outage | Snapshot only |

## Timing
- Routine: reminder at 1 business day → backup at 2 → escalate at 3.
- Emergency: hours, 24/7.
- Delegation: approver sets delegate + date range (audited) for out-of-office.

## Approval card (UI)
Shows route, current approver, SLA countdown, reminder count, escalation level, and "why you can't approve" when self-approval is blocked.
