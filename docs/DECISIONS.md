# Decision Log — SRS v1.1 Addendum

Grand Hyatt Staff Accommodation Platform · Phase 1 · Adpedia
Consolidated from the requirements discussion of 14 Oct 2026.

**This file overrides `source/srs-v1.0.md` and `source/approval-tree-v1.1.md` wherever they conflict.**

Status legend:
- **DECIDED**: confirmed by Praveen (Adpedia). Build it.
- **DEFAULT**: recommended default. Build it as configurable; Grand Hyatt can change it at sign-off.
- **OPEN**: needs a Grand Hyatt answer. Build behind config or a placeholder; never hardcode.

---

## 1. Platform, scope and access

| # | Decision | Status |
|---|---|---|
| D-01 | One responsive web app. No native mobile app in Phase 1. Phone-first layouts for Resident, Technician, Contractor, Security and Housekeeping. | DECIDED |
| D-02 | Login with username + password. No MFA in Phase 1. Admin sessions stricter than resident sessions (configurable timeouts). | DECIDED |
| D-03 | Re-confirm (password re-entry) on high-risk actions: emergency check-in, overrides, clearance waiver, Mark as Left, role changes. Compensates for no MFA. | DEFAULT |
| D-04 | No HRMS integration. Minimal staff profiles, manual or CSV entry by the Accommodation Admin. | DECIDED |
| D-05 | Employee ID is the unique business key (normalised: trimmed, case-insensitive). Not the DB primary key. Duplicates rejected/flagged before save; no auto-merge. | DECIDED |
| D-06 | Email is optional. Username defaults to employee ID. | DECIDED |
| D-07 | Account activation: invitation link if email exists; otherwise admin-assisted temporary credential handed over via an approved offline process. Forced password change at first login. | DECIDED |
| D-08 | Password reset is admin-assisted (AA for staff, SA for admin accounts). No self-service email reset required for staff without email. | DEFAULT |
| D-09 | Notifications: in-app + email only. SMS/WhatsApp out of scope, but recommend raising SMS with Grand Hyatt as a small Phase 1 add (phone numbers already stored). | DECIDED / OPEN (SMS) |
| D-10 | Financial automation (charges, deposits, refunds, payment gateway, payroll) deferred to Phase 2. Phase 1 records damage/loss items only, with no amounts billed. | DECIDED |
| D-11 | Out of Phase 1 (state explicitly to the client): lost & found, general inventory, facility booking (GH-17 open), house rules/violations, SSO, offline transactions. | DEFAULT |

## 2. Property hierarchy and setup

| # | Decision | Status |
|---|---|---|
| D-12 | Hierarchy: Site → Building → [Floor] → [Unit] → Room → Bed. **Floor and Unit are optional**, so a villa can be Site → Room → Bed (or Site → Building → Room → Bed). | DECIDED |
| D-13 | Super Admin creates **sites** (villas, apartments) and **buildings** (e.g. Block A/B). | DECIDED |
| D-14 | Accommodation Admin configures **rooms and beds** within assigned sites. | DECIDED |
| D-15 | Building creation can be granted to an AA as a capability, only within their assigned sites. | DECIDED |
| D-16 | The bed is the unit of occupancy. Room/building/site figures are roll-ups of bed states. | DECIDED |
| D-17 | **Bed state model**: the bed has a *physical/current state* (Available, Occupied, Needs Cleaning, Inspection Required, Blocked, Under Maintenance, Archived), and reservations are **date-ranged records shown alongside**. "Reserved" is not a single bed state, because a bed can be Available today and reserved from next week. | DEFAULT |
| D-18 | **Readiness gates check-in, not future reservations.** A bed in Needs Cleaning can carry a reservation for a later date (same-day turnover). Check-in is blocked until readiness passes. | DEFAULT |
| D-19 | No structure can be archived while occupied, reserved, holding keys/assets or with open work orders. Blocking a parent blocks new allocations to all descendants; existing occupants are flagged, never auto-moved. | DECIDED (SRS) |

## 3. Roles, capabilities and separation of duties

10 groups: **Super Admin (SA), Accommodation Admin (AA), Reception/Accommodation Officer (Rec), Staff/Resident (Res), Maintenance Coordinator (MC), Technician (Tech), Vendor/Contractor (Vend), Security (Sec), Read-only Manager (Mgr), Auditor (Aud).** Line Manager is a possible future group. Full matrix: `PERMISSIONS.md`.

| # | Decision | Status |
|---|---|---|
| D-20 | Permissions = Module × Action × Scope, enforced server-side on every API, report and export. UI hiding is cosmetic only. | DECIDED |
| D-21 | **Resident is a base role** any staff member can hold. Operational groups/capabilities are added on top (e.g. a Technician who lives on site). | DECIDED |
| D-22 | **Capability grants add actions, never scope.** Only SA reassigns a user's sites/buildings. Grants are reason-required, optionally time-limited, audited. | DECIDED |
| D-23 | Housekeeping is a **capability**, not a role. Officers assign cleaning and may update readiness; housekeeping staff with the capability see assigned rooms, complete cleaning checklists and report issues. A separate Housekeeping role can be added later without changing the workflow. | DECIDED |
| D-24 | Final inspection (readiness → Available) only by an authorised inspector (Rec/AA with Final Inspection capability). | DECIDED |
| D-25 | **Policy Approver** capability (business authority, e.g. Accommodation Manager or HR Head) takes policy and exception decisions. SA keeps system configuration, permissions and maker-checker. SA accounts are IT-owned (GH-01) and shouldn't decide gender exceptions or 2 a.m. emergency approvals. | DEFAULT |
| D-26 | Separation of duties. Nobody may: approve their own request/exception/extension/transfer; allocate themselves a bed; process their own check-in; clean or inspect their own room; verify their own work order; approve their own emergency check-in. Enforced in the API. | DECIDED |
| D-27 | Last active SA cannot be removed or downgraded. Role/permission changes and capability grants use maker-checker. | DECIDED |
| D-28 | Security sees identity-check data only (name, photo, room), never eligibility data. Security handles SOS response and can hold the Night Keys capability. | DECIDED |
| D-29 | Read-only Manager has no user/role access; operational reports only; export only if granted. | DECIDED |
| D-30 | Resident may edit only phone and emergency contact. AA is the source of truth for the rest. | DECIDED |
| D-31 | Contractor records job start/finish; Security records gate check-in/out. | DECIDED |
| D-32 | Out-of-office **delegation**: an approver sets delegate + date range (audited). This is how the system knows an approver is absent. | DEFAULT |

Grantable capabilities: Housekeeping, Final Inspection, Emergency Check-in (initiate), Building Creation, Night Keys, Backup Approver, Policy Approver, Outage Export, Staff Master/HR (for non-AA users).

## 4. Staff lifecycle

| # | Decision | Status |
|---|---|---|
| D-33 | Minimum staff profile: employee ID, full name, gender (if eligibility uses it), department, designation/grade (if entitlement uses it), phone, email (optional), joining date, employment status (Active/Left), emergency contact. CSV template in SRS Appendix A. | DECIDED |
| D-34 | CSV import always previews accepted / duplicate / invalid / warning rows before commit; rejected rows downloadable with reasons; guards against formula injection. | DECIDED |
| D-35 | Exit: AA selects **Mark as Left** → confirm + effective date + reason. Login deactivated and sessions invalidated **immediately**. Clearance case opens. Occupied bed is NOT released until actual checkout. | DECIDED |
| D-36 | On Mark as Left the system auto-closes waitlist entries, withdraws open offers, cancels future reservations/visitor passes, and converts any pending emergency approval into the clearance case. | DEFAULT |
| D-37 | Future-dated exit (notice period): does login stay active until the effective date? | OPEN |
| D-38 | Mark as Left notifies the Policy Approver. Bulk exit requires a preview. | DEFAULT |
| D-39 | Access is tied to employment, not to the stay. A resident who checks out but is still employed keeps login and history. | DECIDED |
| D-40 | **No deletion, ever** (routine or hard). Records and audit history retained. Former staff archived out of default active lists but searchable by authorised users. Legal/privacy check flagged to Grand Hyatt (GH-11). | DECIDED |
| D-41 | Rehire reuses the existing profile (same employee ID) via authorised reactivation. Blocked while an old clearance case is open, unless waived by the Policy Approver. | DEFAULT |
| D-42 | Promotion or gender-data change mid-stay that makes the current bed non-compliant: flag for AA; never auto-move. | DEFAULT |

## 5. Request, waitlist and offers

| # | Decision | Status |
|---|---|---|
| D-43 | Request, Approval, Reservation and Stay are **separate records with separate states**. | DECIDED |
| D-44 | AA approval of a standard request **selects the bed and creates the reservation in one atomic step**. Reception then executes check-in. | DEFAULT |
| D-45 | No auto-approval of any request category in Phase 1. | DEFAULT |
| D-46 | Requests whose arrival date falls inside the approval SLA are flagged **Urgent** and sorted to the top of the AA inbox. | DEFAULT |
| D-47 | **Waitlist entry valid 15 calendar days.** Reminders at 3 and 1 days before expiry (configurable). Auto-closes at expiry unless renewed. | DECIDED (15d) / DEFAULT (reminders) |
| D-48 | Waitlist renewal: AA, after eligibility revalidation. Position kept only if renewed before expiry with unchanged requirements. | DEFAULT / OPEN (GH-05) |
| D-49 | **Bed offer: 48-hour acceptance window**, separate from the 15-day entry. One active offer per resident. The offer holds the bed; an admin cannot directly allocate a held bed until the offer resolves. | DECIDED |
| D-50 | First decline keeps queue position and skips that offer. Second decline moves the entry to the back of the eligible queue. | DECIDED |
| D-51 | The 48h timer starts on **confirmed delivery** (offer viewed in-app, or email confirmed) **or** documented staff follow-up ("informed offline"). | DECIDED |
| D-52 | If not viewed within **24h**, alert Reception to inform the resident in person/by phone and record it. Reception/AA can accept on the resident's behalf with consent recorded and audited. | DEFAULT |
| D-53 | Queue order: approved priority category, then oldest valid waiting timestamp. Priority categories to be defined. | DEFAULT / OPEN (GH-04) |

## 6. Reservation, check-in and stay

| # | Decision | Status |
|---|---|---|
| D-54 | **Planned end date required** for standard stays. Open-ended stays only for approved staff categories/policies, each with a **review date** (default every 6 months). | DECIDED (end date) / DEFAULT (review) |
| D-55 | End-date reminders at 14, 7 and 1 days before (configurable). | DEFAULT |
| D-56 | Overdue stay: flagged on the AA dashboard on day 1, escalated to the Policy Approver after a grace period (default 3 days). Never auto-checkout. | DECIDED (flag) / DEFAULT (timing) |
| D-57 | Extension request (resident or AA): validate bed availability, eligibility and conflicting future reservations. If the next booking on that bed clashes, offer a transfer instead of rejecting. Within policy: AA approves. Beyond policy: Policy Approver. | DECIDED (workflow) / DEFAULT (routing) |
| D-58 | **No-show**: reservation expires 24h after the planned arrival date. AA may extend once with a reason. | DEFAULT |
| D-59 | Check-in commits stay activation + bed occupancy atomically. Eligibility and readiness revalidated at check-in. | DECIDED (SRS) |
| D-60 | **Bulk allocation**: select staff → auto-match eligible beds → preview conflicts → confirm → per-row result with retry-safe partial failures. **Bulk check-in** for batch arrivals. | DEFAULT (in scope; flow defined here) |
| D-61 | **Transfer**: lock/reserve the destination before releasing the source; atomic; on failure the resident stays put. Key return/reissue recorded. | DECIDED (SRS) |
| D-62 | **Swap** (both beds occupied) is a separate atomic two-way operation, not two transfers. | DEFAULT |
| D-63 | **Voluntary checkout** (still employed) is its own flow: resident request → Reception processes (no approval) → keys/inspection → bed to Needs Cleaning. Acknowledge within 1 business day. | DEFAULT |
| D-64 | Checkout ≠ clearance complete ≠ bed ready. After checkout the bed goes to Needs Cleaning / Inspection Required, and becomes Available only after final inspection. | DECIDED |
| D-65 | Bulk emergency relocation when a room/building becomes unsafe (fire, leak). | DEFAULT |

## 7. Emergency check-in

| # | Decision | Status |
|---|---|---|
| D-66 | Provisional stay; only holders of the Emergency Check-in capability can initiate. | DECIDED |
| D-67 | 24h initial decision deadline; **re-alert the approver every 24h**; escalate after two unanswered reminders. **Never auto-approve, never auto-checkout.** | DECIDED |
| D-68 | Initiator ≠ approver. Rec-initiated: AA approves. AA-initiated: Policy Approver approves. Escalation goes to the backup approver, then the Policy Approver/SA. | DEFAULT |
| D-69 | Rejection: reason required; creates a relocation/checkout task owned by AA with a deadline. Resident is never moved automatically. | DECIDED |
| D-70 | Maximum provisional duration = critical escalation threshold only, not auto-checkout. Value open (GH-19). | OPEN |

## 8. Clearance, keys, housekeeping and maintenance

| # | Decision | Status |
|---|---|---|
| D-71 | Clearance case stays open after login deactivation; AA acts on the resident's behalf with audit attribution. Cannot close while mandatory items are unresolved, except via **clearance waiver** (Policy Approver, reason + evidence). | DECIDED / DEFAULT (waiver) |
| D-72 | Key model (room key, bed locker key, or both) for shared rooms. | OPEN |
| D-73 | Lost/damaged key is never marked returned; replacement retires the old key and links the new one. | DECIDED (SRS) |
| D-74 | Work order: Resolved ≠ Verified ≠ Room ready. Technician/contractor cannot verify their own work. | DECIDED |
| D-75 | Routine inspections (periodic, with photo evidence) in Phase 1? | OPEN |

## 9. Visitors, contractors, security and SOS

| # | Decision | Status |
|---|---|---|
| D-76 | Contractor: restricted login, own vendor's assigned jobs only, valid only within contract + documents + job + visit window. | DECIDED |
| D-77 | SOS goes to on-duty Security + accommodation emergency contact. Acknowledgement threshold default 5 minutes, then escalate to Security Supervisor / designated authority. Night-time coverage roster needed, since AA is likely day-shift. | DEFAULT / OPEN (GH-08) |
| D-78 | Physical/phone emergency fallback is required because the app cannot guarantee delivery during an outage. | DECIDED (SRS) |
| D-79 | Visitor hours, host confirmation, overnight rules. | OPEN (GH-10) |

## 10. Approvals and timing

Full table: `APPROVALS.md`.

| # | Decision | Status |
|---|---|---|
| D-80 | Timeouts only remind and escalate. Nothing auto-approves, auto-rejects, moves or checks out a resident. | DECIDED |
| D-81 | Routine SLA: 2 business days; maintenance triage 1 business day. | DEFAULT |
| D-82 | Routine escalation: reminder at 1 business day → route to backup at 2 → escalate at 3. | DEFAULT |
| D-83 | Self-approval auto-routes to an independent approver (backup, then Policy Approver/SA). | DECIDED |

## 11. Migration (go-live)

| # | Decision | Status |
|---|---|---|
| D-84 | Request an Excel/CSV export: occupants + employee IDs; sites/buildings/floors/rooms/beds; current bed assignments + expected departure dates; employment status + eligibility fields; outstanding keys, clearance items, maintenance issues. | DECIDED |
| D-85 | Process: data audit → mapping → import to staging → reconcile occupancy vs physical inventory → resolve duplicates → client sign-off → production import. | DECIDED |
| D-86 | **Import Current Occupancy** tool: CSV of employee + bed + start date (+ end date), with preview, validation and audit. Creates stays tagged `source = Migrated`, bypassing request/reservation. Maker-checker sign-off. | DEFAULT |
| D-87 | Migrated stays without an end date are imported as "End date pending"; AA must assign end dates (or approved open-ended status + review date) within 30 days. | DEFAULT |
| D-88 | Outstanding keys from the old system import as Issued, linked to bed and resident. | DEFAULT |
| D-89 | Current occupant count, number of rooms/beds, source file format, data owner. | OPEN |

## 12. Outage

| # | Decision | Status |
|---|---|---|
| D-90 | No HRMS, so outage = network only. Reception (Outage Export capability) downloads a watermarked arrivals/departures snapshot; paper log during outage; post-restoration reconciliation with conflict review. No offline bed allocation. | DECIDED |

## 13. Design system and UX

| # | Decision | Status |
|---|---|---|
| D-91 | Visual direction from the Grand Hyatt logo: red palette, clean modern, glass effects, enterprise look. | DECIDED |
| D-92 | Red is the brand colour, so **error/danger needs a distinct treatment** (it can't share the brand red). Status chip system covers ~12 entity types. | DEFAULT |
| D-93 | Every blocked state explains itself: reason + owner + next action (e.g. "Vacant · awaiting final inspection · Housekeeping"). | DEFAULT |
| D-94 | Resident home is built around their current status (none / applied / waitlisted / offered / reserved / staying / checking out), not a module menu. | DEFAULT |
| D-95 | One approval inbox pattern across all modules. Each card shows route, current approver, SLA countdown, reminder count, escalation level, and why you can't approve (when blocked). | DEFAULT |
| D-96 | A user with Resident + an operational role switches between "My stay" and "My work". | DEFAULT |

## 14. Build approach

| # | Decision | Status |
|---|---|---|
| D-97 | Figma designs + clickable prototype of core flows before full development. | DECIDED |
| D-98 | Prototype covers: role-based dashboards; staff onboarding + CSV import; bed inventory + allocation; waitlist + offer acceptance; check-in, transfer, checkout; clearance + housekeeping; emergency approval + escalation. | DECIDED |
| D-99 | Recommendation: Figma for screens; a small **coded** prototype (dummy data, real state changes) for the flows Figma can't fake: allocation with conflict, waitlist offer/decline timers, emergency escalation. | DEFAULT |
| D-100 | A clickable prototype is a demo: no production database, auth enforcement or real notifications. | DECIDED |

---

## Open questions for Grand Hyatt (consolidated)

1. Primary/backup approver names per route; who holds Policy Approver (D-25).
2. Eligibility matrix: gender/grade rules, room types, exception approvers (GH-03).
3. Waitlist priority categories and renewal rule (GH-04, GH-05).
4. How residents without email learn about offers; is SMS acceptable (D-09, D-52)?
5. Future-dated exit and login (D-37).
6. Emergency: max provisional duration, rejection-resolution SLA, night coverage (GH-07, GH-19, GH-20).
7. SOS recipients, acknowledgement SLA, fallback (GH-08).
8. Visitor policy (GH-10).
9. Key model for shared rooms (D-72).
10. Periodic inspections in Phase 1 (D-75)?
11. Retention/legal check on "never delete" (GH-11).
12. Migration: occupant count, room/bed count, file format, data owner (D-89).
13. Password/session policy values (GH-14).
14. Maintenance SLAs and KPI definitions (GH-16).
15. Facility booking in or out (GH-17).
