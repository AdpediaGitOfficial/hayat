# Grand Hyatt Staff Accommodation Platform — Phase 1

Client: Grand Hyatt · Delivered by: Adpedia · Design lead: Praveen Divakaran

A role-based web platform that manages staff housing from staff record → eligibility → request → reservation → check-in → active stay → checkout → clearance → bed turnover → available again.

## Read before any work

1. `docs/DECISIONS.md`: **source of truth**. 109 numbered decisions (D-01 to D-109) with status DECIDED / DEFAULT / OPEN. Overrides everything in `docs/source/`.
2. `docs/PERMISSIONS.md`: corrected role × module matrix and capabilities.
3. `docs/APPROVALS.md`: approval routes, escalation and timing.
4. `docs/source/srs-v1.0.md`: full SRS (data model §4, state transitions §6, acceptance tests AT-001 to AT-032 §16, invariants Appendix B).
5. `docs/GAP-ANALYSIS.md` and `docs/PLAN.md`: review of the Full Project Document v1.1 and the external HTML prototype; the production build plan (decisions T-1 to T-10, stages, acceptance-test mapping, prototype hardening list).
6. `docs/source/approval-tree-v1.1.md`, `user-journey-and-module-map.md`, `journey-review-notes.md`, `user-groups-draft.md`, `Grand_Hyatt_Full_Project_Document_v1.1.docx`, `external-html-prototype.html`: earlier inputs, kept for history. The Full Project Document §20/§21 predate D-25 (Policy Approver); see `GAP-ANALYSIS.md` section 2 for the conflicts.

If a request conflicts with DECISIONS.md, point out the conflict before building. Never hardcode an OPEN item; make it configurable or a clearly marked placeholder.

## Non-negotiable invariants

- The **bed** is the allocation unit. A bed never has two overlapping active reservations or stays.
- Request ≠ Reservation ≠ Stay. Checkout ≠ Clearance complete ≠ Bed ready. Resolved ≠ Verified.
- Bed has a physical state; reservations are date-ranged alongside it. Readiness gates **check-in**, not future reservations.
- Reservation, check-in, transfer, swap and checkout are **atomic** and concurrency-safe. A failed transfer leaves the resident where they were.
- **Timeouts never auto-approve, auto-reject, move or check out anyone.** They only remind and escalate.
- **No self-approval**; separation of duties enforced in the API (D-26).
- Permissions = Module × Action × Scope, **server-side** on every API, report and export. Capability grants add actions, never scope.
- **No deletion.** Archive only. Audit log is append-only.
- Mark as Left → login revoked immediately; bed is NOT freed until actual checkout.
- Hierarchy: Site → Building → [Floor] → [Unit] → Room → Bed (Floor and Unit optional). SA creates sites and buildings; AA creates rooms and beds.
- Employee ID is the unique business key; email optional; username defaults to employee ID.
- Notifications: in-app + email only. A notification failure never changes business state.

## Key numbers (configurable)

Waitlist entry 15 days · bed offer 48h from confirmed delivery · offer not viewed in 24h → Reception follow-up · 1st decline keeps position, 2nd → back of queue · emergency: 24h deadline, re-alert every 24h, escalate after 2 unanswered · routine SLA 2 business days · no-show 24h after arrival date · SOS acknowledgement 5 min.

## Roles

SA, AA, Reception/Officer, Resident (base role, can stack), Maintenance Coordinator, Technician, Vendor/Contractor, Security, Read-only Manager, Auditor. Capabilities: Housekeeping, Final Inspection, Emergency Check-in, Building Creation, Night Keys, Backup Approver, Policy Approver, Outage Export, Staff Master.

## Design direction

Grand Hyatt red palette, clean modern enterprise UI, glass effects. Error/danger must be visually distinct from the brand red. Status chips are the main visual language. Every blocked state shows reason + owner + next action. Responsive web; phone-first for Resident, Technician, Contractor, Security and Housekeeping.

## Build plan

**Stack (D-101, D-102):** Next.js 14 (App Router) + React 18 + TypeScript in `prototype/`; PostgreSQL for production (see `prototype/README.md`; `npm run dev`, `npm test`). Design tokens and components follow `docs/design/GrandHyatt-Design-System.html`.

**Production app (`platform/`): Stages 0, 1 and 2 built (exit gates green, `docs/STAGE-1.md` section 10, `docs/STAGE-2.md` section 12); Stage 3 next** (see `platform/README.md`, `docs/STAGE-1.md`; `docs/PLAN.md` has the result and open decisions S-1 to S-7). Run `cd platform && npm run db:migrate && npm test` against a local Postgres 16.

**Step 0 (built, hardened): clickable prototype.** Dummy data, no real backend/auth/notifications (D-97 to D-100).
Prototype flows, in priority order:
1. Role switcher + role-based dashboards
2. Bed inventory grid (site → room → bed, physical state + upcoming reservations)
3. Request → AA approval (selects bed, creates reservation) → check-in wizard
4. Waitlist → offer → accept/decline with live 48h / 15d timers
5. Allocation conflict (two users, same bed) + bulk allocation preview
6. Transfer and swap
7. Mark as Left → clearance → housekeeping → final inspection → Available
8. Emergency check-in → reminders → escalation
9. Staff onboarding + CSV import preview + Import Current Occupancy (migration)

**Then production**, following SRS §18:
Stage 1 Foundation (auth, roles/scopes, audit, hierarchy, beds, staff, CSV) → Stage 2 Accommodation core → Stage 3 Clearance & readiness → Stage 4 Operations & security → Stage 5 Notifications & reporting → Stage 6 UAT & launch. Each stage's exit gate = the relevant acceptance tests in SRS §16.

## Working conventions

- Keep DECISIONS.md current: when Praveen decides something new, add or update a numbered D-item with its status.
- When an OPEN item is answered by Grand Hyatt, change its status and note the date.
