# Build Plan: Production Application

Grand Hyatt Staff Accommodation Platform · Phase 1 · Adpedia · 14 Oct 2026

**Status:** proposal for review. Nothing here overrides `DECISIONS.md`. Where this plan needs a decision, it says so and recommends an answer (section 3). Gaps referenced as G-xx and conflicts as C-x are in `GAP-ANALYSIS.md`.

**Starting point:** the clickable prototype in `prototype/` already holds the business rules (`src/domain/rules.ts`, `store.ts`) and 32 passing scenario tests. The production build keeps the screens, design system and rules, and replaces the in-memory store with a real server, database, authentication and background jobs.

---

## 1. Design principles

Each non-negotiable invariant from `CLAUDE.md` becomes a concrete design rule.

| Invariant | Design consequence |
|---|---|
| A bed never has two overlapping reservations or stays | Enforced by a **database exclusion constraint**, not only application code (section 5). |
| Reservation, check-in, transfer, swap and checkout are atomic and concurrency-safe | One command = one database transaction. Row locks on the bed. Idempotency key on every command. |
| Permissions are Module × Action × Scope, server-side on every API, report and export | One policy module, deny by default, **scope injected into every query** by the repository layer. Out-of-scope reads return "not found". |
| No self-approval (D-26) | Checked inside the command, before the transaction commits, with a test per route. |
| Mark as Left revokes login immediately | **Database-backed sessions** (not stateless tokens), so revocation is a row update. |
| Timeouts only remind and escalate | Background jobs are written as "notify and escalate" handlers. A test asserts that no job ever changes an approval, stay or resident's bed. |
| No deletion; audit is append-only | Application database role has no `DELETE` on business tables and no `UPDATE` or `DELETE` on the audit table. Archive flags only. |
| Notification failure never changes business state | Notifications go through an **outbox** written in the same transaction, delivered by a separate worker. |
| Request ≠ Reservation ≠ Stay; Checkout ≠ Clearance ≠ Bed ready | Separate tables and separate state machines. |

---

## 2. Scope of the production build

In: everything in FPD §2.1 as amended by the decision log (D-01 to D-101). Out: the items in FPD §2.2 and D-11.
The nine prototype flows are the first user journeys to be built end to end; Stages 4 and 5 add the security, contractor, visitor, reporting and outage work that the prototype only sketches.

---

## 3. Decisions needed before Stage 1

Recommendation first, then the alternative and what it costs.

| # | Decision | Recommendation | Why | Alternative and cost |
|---|---|---|---|---|
| **T-1** | **Database** (**decided: D-102**) | **PostgreSQL 16** | Range-exclusion constraints give a hard guarantee of no double allocation. Real transactions and row locks. Row-level security available as a second line of defence. Mature backup and recovery. Fits Next.js (D-101). | **Firestore** (assumed by the HTML prototype): no range constraint, so the overlap rule would rest only on application transactions. Transaction size and contention limits for bulk allocation. Reporting and CSV exports need extra pipelines. Ties the client to one cloud vendor. |
| T-2 | Hosting | Containers, cloud-neutral. Region and provider chosen with Grand Hyatt IT. | Hosting is not decided (NFR-10, GH-14). A container image runs anywhere. | A managed platform is faster to start but can lock in choices GH IT may reject. |
| T-3 | Authentication | Username + password, **Argon2id** hashing, **database sessions**, forced change at first login, lockout, admin-assisted reset (D-02, D-07, D-08). Build on Auth.js credentials or a small in-house module over the sessions table. | Immediate revocation is a hard requirement. | Stateless JWT cannot be revoked instantly. |
| T-4 | Data access | **Drizzle ORM** plus hand-written SQL migrations | Exclusion constraints and triggers must be raw SQL anyway; Drizzle stays out of the way. | Prisma is fine for CRUD but hides these constructs. |
| T-5 | Background jobs | **pg-boss** (queue in Postgres) | No extra infrastructure; transactional enqueue; retry and backoff built in. | Redis/BullMQ adds a service to run. |
| T-6 | Email | Provider adapter over SMTP or API (GH-13) | Provider not chosen. | None. |
| T-7 | File storage | S3-compatible object storage, private, signed URLs | G-10. | Local disk is not durable. |
| T-8 | Validation | **Zod** at every boundary | One schema for forms and API. | None. |
| T-9 | Tests | **Vitest** (domain, API), **Postgres in a container** for integration, **Playwright** for per-role end-to-end | Matches the prototype's test runner. | None. |
| T-10 | Approval engine | **Fixed route types** with configurable named approvers, SLAs and delegation (G-03) | Keeps scope bounded; routes are already specified in `APPROVALS.md`. | A visual workflow designer roughly doubles the approvals effort. |

---

## 4. Architecture

```
Browser (Next.js, React, design system)
   │  server components + typed route handlers / server actions
   ▼
Application commands            one per business action, one transaction each
   │   validate (Zod) → authorize (policy) → separation-of-duties → execute → audit → enqueue notifications
   ▼
Domain rules (pure TypeScript)  eligibility, overlap, state machines, timing; no I/O; shared with the UI for hints
   ▼
Repositories                    every query takes a Scope; out-of-scope rows are invisible
   ▼
PostgreSQL                      constraints, triggers, audit table, pg-boss queue

Workers (same codebase, separate process)
   • scheduler tick   → reminders, expiries, escalations (never decisions)
   • notification outbox → email and in-app, retries, delivery status
   • import / export jobs
```

Cross-cutting: an injectable **clock** (the prototype's demo clock becomes the test clock), structured logs with a request id, a policy module, an audit writer, an outbox writer.

Repository layout:

```
app/            Next.js routes and pages
src/domain/     pure rules and state machines (ported from the prototype)
src/server/     commands, repositories, policy, jobs, notifications
src/ui/         design-system components (ported)
db/migrations/  numbered SQL migrations
tests/          unit, integration, e2e, acceptance (AT-001 to AT-032)
```

---

## 5. Data model

All timestamps are stored in UTC and shown in the site time zone (G-01, NFR-11). Identifiers are immutable UUIDs; **employee ID is a unique business key**, normalised (trimmed, case-insensitive), never the primary key (D-05).

**Property:** `site`, `building`, `room`, `bed`. Floor and unit are nullable columns, so a villa is Site → Room → Bed (D-12). `bed.state` holds the physical state only (D-17).
**People and access:** `staff_profile`, `user_account`, `role_assignment` (role + scope), `capability_grant` (reason, expiry, maker, checker), `session`, `delegation`.
**Accommodation:** `accommodation_request`, `approval` (route, version, step, due time, reminder count, escalation level), `waitlist_entry`, `bed_offer`, `reservation`, `stay`, `transfer`, `extension`, `emergency_stay`, and **`bed_claim`** (below).
**Exit and readiness:** `clearance_case`, `clearance_item`, `key`, `key_transaction`, `cleaning_task`, `inspection`.
**Operations and security:** `work_order`, `visitor`, `vendor`, `contract`, `contractor_visit`, `incident`.
**Platform:** `notification`, `notification_attempt`, `audit_event`, `config_item` (versioned), `calendar`, `attachment`, `import_batch`, `import_row`, `outage_snapshot`, `reconciliation_item`.

### 5.1 The constraints that carry the invariants

```sql
-- Requires:  CREATE EXTENSION btree_gist;
-- One row per active claim on a bed: a reservation, an offer hold, or a stay.
-- Reservation and stay stay separate business records (D-43); each points at its claim,
-- and check-in converts the reservation's claim into the stay's claim in place.
CREATE TABLE bed_claim (
  id        uuid PRIMARY KEY,
  bed_id    uuid NOT NULL REFERENCES bed(id),
  kind      text NOT NULL CHECK (kind IN ('reservation','offer_hold','stay')),
  period    daterange NOT NULL,                       -- '[start, end+1)'; open-ended stays have no upper bound
  CONSTRAINT no_double_allocation
    EXCLUDE USING gist (bed_id WITH =, period WITH &&)
);

-- Employee ID is unique after normalisation.
CREATE UNIQUE INDEX staff_employee_id_norm ON staff_profile (lower(btrim(employee_id)));

-- One active offer and one active stay per person.
CREATE UNIQUE INDEX one_active_offer_per_staff ON bed_offer (staff_id) WHERE status = 'pending';
CREATE UNIQUE INDEX one_active_stay_per_staff  ON stay (staff_id)      WHERE status = 'active';

-- Audit is append-only: the application role may only INSERT and SELECT.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM app_role;
```

State machines (FPD §6 as corrected by C-3 and C-4) are enforced twice: in the domain layer, and by a transition table with a trigger that rejects illegal moves.

---

## 6. Permissions, scope and separation of duties

- **One policy module**, `can(actor, action, resource)`, generated from a single table that mirrors `PERMISSIONS.md`. Every route handler, server action, report and export calls it. Deny by default.
- **Scope in the query, not after it.** Repositories require a `Scope` (sites, buildings, own-record, job). Out-of-scope reads return not found, not forbidden (AT-002).
- **Capability grants add actions, never scope** (D-22). Only SA changes scope. Grants require a reason, optional expiry, and a second SA to approve (D-27).
- **Separation of duties** (D-26) is a rule list evaluated inside the command, with the reason returned in the blocked-state triple the UI already shows: reason, owner, next action (D-93).
- **Contract test:** a generated table of role × module × action × scope expectations runs against the real API. This is AT-001, AT-002, AT-031 and AT-024 in one suite, and it fails the build if a route is added without a policy entry.
- Optional second line of defence: Postgres row-level security keyed to the session's scope.

---

## 7. Commands and transactions

Each prototype action (`A.*` in `store.ts`) becomes a command with the same name and rules. Every command:

1. Validates input (Zod) and checks the **idempotency key**.
2. Authorizes (policy, scope, separation of duties).
3. Opens a transaction and locks the rows it touches (`SELECT … FOR UPDATE` on the bed).
4. Re-validates eligibility, availability and state at that moment (so two admins picking the same bed cannot both win).
5. Writes the change, the **audit event** and the **notification outbox rows**.
6. Commits, or rolls back everything. Returns a result carrying reason, owner and next action on failure.

Transfer reserves the destination claim before releasing the source claim, inside one transaction (D-61). Swap is one two-way command (D-62). Bulk allocation runs each row in its own savepoint so one failure never poisons the batch (D-60).

---

## 8. Time-driven work (reminders and escalation, never decisions)

A scheduler runs every minute and selects due items with `FOR UPDATE SKIP LOCKED`, so several workers can run safely. Handlers are idempotent.

| Job | Rule | Source |
|---|---|---|
| Waitlist reminders and expiry | Remind 3 and 1 days before; close at 15 days | D-47 |
| Offer follow-up and expiry | Alert Reception at 24h unseen; expire at 48h from confirmed delivery; release the hold | D-49, D-51, D-52 |
| Reservation expiry | 24h after arrival time unless extended once | D-58 |
| Approval reminders | 1 business day remind, 2 route to backup, 3 escalate | D-82 |
| Emergency escalation | Re-alert every 24h; escalate after two unanswered | D-67 |
| Stay end reminders and overdue | 14, 7, 1 days; flag day 1; escalate after grace | D-55, D-56 |
| SOS acknowledgement | Escalate if unacknowledged within the interval | D-77 |
| Contractor overstay | Alert Security | FPD §5.7 |
| Notification retries | Bounded backoff | NFR-05 |

**Guard test:** after running every job against a seeded database, assert that no approval, stay, bed assignment or resident location changed except the specified expiries of waitlist entries, offers and reservations.

---

## 9. Notifications

- **Catalogue first** (G-06): a table of event × recipient × channel × timing × template × dedupe key, reviewed with Grand Hyatt.
- Outbox pattern: the row is written in the business transaction; a worker sends it. Retry with backoff; status queued → sent → delivered or failed; **provider "accepted" is never shown as "delivered"** (G-07).
- Deduplication key per event, recipient and time window (AT-030).
- A critical alert that fails after retries raises an admin-dashboard banner and escalates inside the platform (FPD §10.1).
- In-app inbox with read and unread state. SMS and WhatsApp are out of scope (D-09).

---

## 10. Interface

- Keep the design system and the prototype's screens. Screens read through typed server functions instead of the in-memory store.
- Phone-first for Resident, Technician, Contractor, Security and Housekeeping (D-01). Tablet and desktop for admins.
- Every blocked state shows reason, owner and next action (D-93). One approval inbox pattern (D-95).
- Accessibility target **WCAG 2.1 AA** (G-20): keyboard operation, focus handling in drawers and modals, screen-reader labels, contrast in both themes. Checked with automated tests and a manual pass before UAT.
- All text in message catalogues, English first (G-21).
- Placeholders from the prototype (national ID, photo, static trends) are removed or replaced by real fields (G-05).

---

## 11. Quality and security

**Testing pyramid**
- Domain unit tests: the existing 32, extended to the full rule set.
- Integration tests against real Postgres: every command, every constraint, concurrent-allocation tests with parallel connections (AT-008).
- Contract tests for permissions (section 6).
- Playwright end-to-end per role, including phone viewport.
- **Acceptance suite:** AT-001 to AT-032 each have one named automated test. Stage exit gates are these tests going green.

**Security**
- Target OWASP ASVS Level 2.
- Argon2id; login rate limiting and lockout; CSRF protection; strict cookies; Content Security Policy.
- CSV formula-injection guard on import and export (already in the prototype); watermarked, audited exports (D-90).
- Uploads: type and size limits, malware scan, private storage.
- Personal data shown only to roles that need it; exports use minimum data (NFR-08).
- Secrets in a secret manager. Independent penetration test before UAT.

**Operations**
- Environments: local, CI, staging, UAT, production. Synthetic data outside production (G-22).
- CI (GitHub Actions): typecheck, lint, unit, integration with a Postgres service, e2e, migration check, dependency audit.
- Backups with a tested restore drill; point-in-time recovery; planning basis RPO 15 min, RTO 4 h (G-18, placeholder).
- Structured logs with request ids; audit kept separate from application logs; health and job-lag monitoring.

---

## 12. Prototype hardening (parallel track): done

All fifteen items are built and covered by tests (70 in total). The prototype now shows every Phase 1 flow.

| # | Item | Status |
|---|---|---|
| P-1 | Delegation routes approvals; separation of duties still applies to the delegate | Done |
| P-2 | End-date reminders, overdue escalation notices, checkout acknowledgement | Done |
| P-3 | Notification delivery log: queued, retrying, sent, delivered, failed; dedupe; offer clock starts on confirmed email delivery | Done |
| P-4 | Visitor register and gate flow | Done |
| P-5 | Contractor visit windows, gate checks, vendor scope | Done |
| P-6 | SOS escalation chain | Done |
| P-7 | Audited outage export and reconciliation | Done |
| P-8 | Rehire | Done |
| P-9 | Users, capability grants, maker-checker, account revocation | Done |
| P-10 | Room and building archive with dependency checks; blocking cascade | Done |
| P-11 | Date-ranged bed blocks | Done |
| P-12 | "Approved, action failed" label and "changes requested" loop | Done |
| P-13 | Invented fields and static trends removed | Done |
| P-14 | AT-021 reworded, CSV preview and partial import tested; amendments for SRS v1.2 written | Done (`SPEC-AMENDMENTS.md`) |
| P-15 | Guided demo journey | Done |

---

## 13. Delivery stages

Stages and exit gates come from SRS §18. Each stage also lists its acceptance tests and the Grand Hyatt answers it depends on. Effort figures are **indicative planning estimates** for a team of roughly three engineers, one QA and part-time design, to be confirmed after decisions T-1 to T-10.

| Stage | Scope | Acceptance tests (exit gate) | Needs from Grand Hyatt | Indicative |
|---|---|---|---|---|
| **0 Decisions and foundation** | Settle T-1…T-10. Scaffold the app, CI, containers, design-system package, schema v0, policy module skeleton, injectable clock. Merge the decision log into SRS v1.2. | CI green; migrations apply; constraint tests for bed overlap and employee ID | Hosting contact (GH IT) | 1–2 weeks |
| **1 Foundation** | Authentication, sessions, roles and scopes, capability grants with maker-checker, audit, site hierarchy, bed inventory, staff profile, CSV import with preview, configuration (calendar, time zone, timers) | AT-001, 002, 003, 004, 005, 028, 029 | Site, building, room and bed list (GH-02); calendar (G-01); password and session policy (GH-14) | 3–4 weeks |
| **2 Accommodation core** | Eligibility, requests, approval inbox and routes, delegation, allocation, reservation, waitlist and offers, check-in, stay, transfer and swap, extensions, emergency check-in, checkout | AT-006 to 013, 015 to 018, 022, 030 | Eligibility matrix (GH-03); approver names (GH-07); priority categories (GH-04) | 5–6 weeks |
| **3 Clearance and readiness** | Mark as Left, clearance, keys and assets, cleaning, final inspection, bed release, attachments, rehire | AT-019, 020, 021, 032 | Key model (D-72); housekeeping owner (GH-18); retention policy (GH-11) | 3–4 weeks |
| **4 Operations and security** | Work orders, contractor login and visit windows, visitor register and gate, incidents and SOS escalation | AT-023, 024, 025 | Contractor rules (GH-09); visitor policy (GH-10); SOS recipients (GH-08) | 4–5 weeks |
| **5 Notifications and reporting** | Notification catalogue and delivery, dashboards by role, reports and controlled exports, outage export and reconciliation | AT-014, 026, 027, 031 | Email provider (GH-13); KPI definitions (GH-16); outage owner (GH-12) | 3–4 weeks |
| **6 UAT and launch** | Role-based end-to-end tests, accessibility pass, penetration test, data migration (Import Current Occupancy), training, runbook, backup and recovery drill, sign-off | All 32 acceptance tests; no open severity-1 defects | Migration files (GH-15, D-89); sign-off register | 3–4 weeks |

Total indicative range: **22–29 weeks** from the start of Stage 0. Stages overlap where dependencies allow (Stage 4 can start once Stage 1 is stable). A decision outstanding on a release blocker moves the date, not the scope.

---

### Stage 0 result

Built and verified in `platform/` (own README): Next.js 14 + strict TypeScript + Vitest; schema v0 in seven SQL migrations with a checksummed runner; the bed-overlap exclusion constraint, one-active-stay and one-active-offer indexes, a database transition guard, an append-only audit table, a login-less `app_role` with no delete rights; a deny-by-default policy module tested against `docs/PERMISSIONS.md`; an injectable clock; a React-free domain port; `GET /api/health`; Dockerfile, compose file and CI workflow. Gate run: typecheck and lint clean, migrations apply, **171 tests pass against a real Postgres**, build succeeds. The container and CI files are written but unrun here (no Docker daemon).

Deviations from section 5: claims have a `released_at` (a released claim stays as history instead of being deleted); "active stay" covers provisional, active and resolution-pending; stay and reservation hold no dates of their own (the claim does); an extra trigger makes audit and config append-only even for the table owner.

**Decisions this surfaced (for Stage 1):**

| # | Question | Recommendation |
|---|---|---|
| S-1 | **Does a stay's end date mean the last night or the departure day?** As stored (`[start, end+1)`), a stay ending 14 Oct conflicts with one arriving 14 Oct, which clashes with same-day turnover (D-18). | Treat the end date as the **departure day** (end-exclusive) and say so in the specification; same-day turnover then works. Needs Grand Hyatt to confirm. |
| S-2 | How does "Resident base role + operational role" become one actor? | One actor per mode ("My stay" / "My work"), as D-96 suggests. |
| S-3 | Five starred cells in `PERMISSIONS.md` name no capability (AA Visitors, Res Visitors, AA Audit log, AA System configuration, Mgr export). | Left denied; Report Export is now proposed for Mgr (SPEC-AMENDMENTS). Others need an answer. |
| S-4 | SA is "Full" on Requests but D-25 says SA should not decide exceptions. | Exceptions and clearance waivers stay Policy Approver only. |
| S-5 | `PERMISSIONS.md` and the prototype differ: the prototype lets AA assign housekeeping and the Policy Approver sign off migration. | Follow the matrix; fix the prototype or the matrix. |
| S-6 | Building-level scope exists in `role_assignment` but not in the actor/resource types. | Add in Stage 1. |
| S-7 | Next.js 14.2.35 has open advisories (1 critical, 4 high) fixed only in later majors; D-101 pins 14. | Revisit before the Stage 6 penetration test; the image optimiser is already disabled. |

Also noted for the commands: take a row lock on the bed first so a lost race always returns the clean "bed taken" error (a deadlock code is also possible and both must map to it); expired sessions need a retention job under a different role; no-self-approval and bed-state-agrees-with-claims stay in the application, not the database.

---

## 14. Release blockers and when they bite

| Blocker (SRS §18.1) | Latest useful date | Consequence if late |
|---|---|---|
| Eligibility matrix and exception owner | Start of Stage 2 | Eligibility ships as a placeholder; cannot go live. |
| Emergency approval chain | Start of Stage 2 (emergency check-in) | Feature built but cannot be enabled. |
| SOS recipients and fallback | Start of Stage 4 | Cannot go live. |
| Retention and privacy policy | Start of Stage 3 | Archive design may change. |
| Bed-capacity baseline | Start of Stage 6 | Migration blocked. |
| Outage-reconciliation owner | Start of Stage 5 | Cannot go live. |
| Contractor-access owner | Start of Stage 4 | Contractor login cannot be enabled. |

Unanswered items are built behind configuration or a clearly marked placeholder, never hard-coded (`CLAUDE.md`).

---

## 15. Top risks

| Risk | Mitigation |
|---|---|
| Double allocation under concurrent use | Exclusion constraint plus concurrent integration tests from Stage 1. |
| Access control gaps | Deny-by-default policy; generated permission contract test; scope in the repository layer. |
| Specification keeps changing | One source of truth (decision log); SRS v1.2 regenerated from it; changes tracked as numbered decisions. |
| Client answers arrive late | Everything unanswered is configuration; release blockers tracked by date (section 14). |
| Timer logic wrong at boundaries (business days, time zones) | Injectable clock; boundary tests; time-zone and calendar configuration from Stage 1. |
| Notification failures hide critical alerts | Outbox with retries; failed critical alerts surface on dashboards and escalate. |
| Scope creep (visitor stays, family rooms, line managers, WhatsApp) | Logged as G-12, G-25 and D-09; need an explicit change request. |
| Hosting or database restricted by client IT | Cloud-neutral containers; decision T-1 and T-2 taken in Stage 0. |

---

## 16. Definition of done (per feature)

- Owner role, scope, validation and failure path documented (FPD §19).
- Permission contract test entry added.
- Command has unit, integration and, where it changes state, concurrency tests.
- Audit event and notification outbox rows verified.
- Blocked states show reason, owner and next action.
- Phone and desktop layouts checked; keyboard and screen-reader pass.
- Related acceptance tests green in CI.

---

## 17. What happens next

1. You confirm or change the remaining technical decisions in section 3. **T-1 (PostgreSQL) is decided (D-102).**
2. I run **Stage 0**: scaffold the production app, CI, container setup and schema v0 with the overlap constraint and its tests, and port the domain rules.
3. The **prototype hardening list** (section 12) is complete.
4. Grand Hyatt receives the blocker and gap question list (`GAP-ANALYSIS.md` section 6).
