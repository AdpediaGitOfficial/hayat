# Stage 2 plan: Accommodation core

Grand Hyatt Staff Accommodation Platform · production app (`platform/`) · 14 Oct 2026

Stage 2 of `PLAN.md` section 13. Exit gate: **AT-006, 007, 008, 009, 010, 011, 012, 013, 015, 016, 017, 018, 022, 030** pass against the real API and a real PostgreSQL, plus the permission contract test, no open severity-1 defects, and every item in section 7 ("proved by tests") green. Method is the one that worked in Stage 1: the lead builds the shared core first (WP-0), then four packages run in parallel in isolated worktrees with fixed file ownership and migration ranges, and the lead merges and verifies the gate.

## 1. Scope

**In:** eligibility checks (placeholder rule set, see GH-03); accommodation requests and their approval; the approvals inbox with SLA clock, reminders and escalation (reminds only); delegation records; the atomic "approve = pick the bed and create the reservation"; reservation cancel and no-show handling; bulk allocation with preview; waitlist (entry, queue order, priority exception, renewal, expiry, reminders); bed offers (hold, 48 h timer from confirmed delivery, unseen follow-up, accept, decline, second-decline requeue, accept on behalf); check-in (single and bulk) creating the stay; transfer and swap; stay extensions; voluntary checkout; overdue and end-date reminders; emergency check-in (provisional stay, approver, 24 h reminders, escalation, rejection with relocation task); in-app notifications with idempotent delivery keys; the scheduled sweeps that drive every timer; the screens for all of it, phone-first for Resident and Reception check-in.

**Out (later stages):** Mark as Left, clearance, keys, cleaning and final inspection (Stage 3; voluntary checkout leaves the bed in Needs cleaning and stops there); work orders, contractors, visitors, SOS (Stage 4); email delivery, dashboards, reports, outage export (Stage 5; notifications are stored in-app with an email status of `pending`); data migration (Stage 6).

**Open and built as configuration or placeholders:** eligibility matrix (GH-03: gender room policy plus a per-site minimum grade, default none); priority categories (GH-04: empty list); waitlist renewal rule (GH-05); approver names (GH-07: backup approvers are capability holders, no names hard-coded); emergency relocation deadline (GH-07: configurable hours); no-show extension limit (D-58).

## 2. Design decisions

| Topic | Decision |
|---|---|
| Site on a request | `accommodation_request.site_id` and `waitlist_entry.site_id` are added (NOT NULL; nothing exists in production yet). The requester or Reception chooses the site; AA and Reception see requests of their sites only (AT-002 style scope). The bed picked on approval must be in that site; moving a request to another site means rejecting with "changes requested" and resubmitting. **S-12 for the product owner.** |
| Allocation primitive | One function, `allocateBed()` in `src/server/allocation/`, used by approval, bulk allocation, offers, transfer, swap and emergency check-in. It locks the bed row (`FOR UPDATE`), rechecks physical state, eligibility and held-by-offer inside the caller's transaction, then inserts the `bed_claim`. Every caller therefore gets the same "bed taken, here is who/what and the next suggested bed" answer (AT-008) and the database exclusion constraint stays the last line of defence. Claims are never deleted: release sets `released_at` and a reason. |
| Dates | D-103: end = departure day, claim `[arrival, departure)`; open-ended only for permanent stays with a review date (D-54). |
| Reservation vs. stay | Check-in converts the reservation's claim into the stay's claim in place (`kind` reservation to stay) in one transaction, revalidating eligibility and readiness (D-59). Readiness gates check-in, never the reservation (D-18). |
| Approvals | No generic approval table. Each business object keeps its own status and decision columns. `src/server/approvals/` defines an `ApprovalSource` interface; each package registers a source; the inbox merges them, applies scope and separation of duties (D-26), and computes the SLA clock (reminder at 1 business day, backup at 2, escalate at 3) from the injected clock and the configured calendar. The inbox item says why an actor cannot decide ("why you can't approve"). |
| Delegation | A delegation row records absence and names a stand-in (D-32). It **adds no authority and no scope**: the stand-in must already hold the role and sees the delegator's reminders and escalations in their own scope. Shown on approval cards. **S-13 for the product owner.** |
| Timers | Every timer is a **sweep**: an idempotent function registered with `registerSweep()` and run by `runSweeps(clock)` (CLI `npm run sweeps`, and an internal POST route guarded by a shared secret for cron). A sweep never approves, rejects, moves or checks anyone out (CLAUDE.md invariant). It may remind, escalate, expire a waitlist entry, expire an offer and release its hold, and expire a no-show reservation (those release holds, they do not decide for a person). Every sweep step is keyed so running it twice, or two instances at once, does the thing once. |
| Notifications | Table `notification`: recipient (staff, role-at-site, or capability), kind, text, reference, **`dedupe_key` unique** (AT-030: a retried event creates one notification), `email_status` (`pending` until Stage 5), `read_at`. Created inside the business transaction, so a rollback leaves none; a delivery failure never changes business state. |
| Queue order | Approved priority category (placeholder list), then oldest valid queue timestamp; second decline sets the timestamp to now and records prior and new sequence in the audit (AT-013). |
| One of each | One active stay per person, one pending offer per person (database indexes from Stage 0); commands turn the resulting `23505` into a clear refusal naming what exists. |
| Separation of duties | `notSelf()` from Stage 1 in every approve, allocate, check-in, extend and emergency decision; emergency initiator can never approve (AT-017, audited as a refusal event that survives the rolled-back decision). |
| Permission contract | Unchanged: every route declares access; the contract test covers every policy-guarded route for every role. |

## 3. Schema additions

All in numbered migrations; `GRANT` to `app_role` only what is needed, never DELETE; registered in the package's schema file.

| Range | Owner | Adds |
|---|---|---|
| 0040–0049 | WP-0 | `site_id` on request and waitlist entry; `notification`; `sweep_run` (lock and last-run record); `eligibility_exception`; delegation indexes; request `urgent` is computed, not stored |
| 0050–0059 | WP-D | request history rows if needed (`request_event`), bulk-allocation batch tables |
| 0060–0069 | WP-E | anything waitlist and offers need beyond Stage 0 (priority grants, offer delivery log) |
| 0070–0079 | WP-F | `transfer_request`, `extension_request`, `checkout_request` |
| 0080–0089 | WP-G | `emergency_checkin` (approver route, reminders, escalation, relocation task link), `task` (generic owned task, used for relocation) |

## 4. Work packages

**WP-0 Allocation core (lead, first):** configuration keys for the new timers and eligibility; `allocation/` (claims service: create, convert, release; `allocateBed`; bed suggestion); `eligibility/` (rules from the prototype ported to the database, exceptions); `notify()` with dedupe; `jobs/` (sweep registry, runner, CLI, guarded route); `approvals/` registry, SLA clock, inbox merge and the `why` rules; Stage 2 test fixtures (requests, reservations, stays, offers, notifications) and a sweep test harness; navigation and "My accommodation" section registries so packages add their pieces without touching shared files; docs. **Why first:** all four packages call these.

**WP-D Requests, approvals and allocation:** submit request (resident, or Reception on behalf; one open request per person), edit/cancel, approval (AA picks the bed, reservation created atomically; Policy Approver for gender and grade exceptions with reason and evidence, all uses reported), reject with reason, changes requested, approvals inbox screen and API, delegation CRUD, reservation cancel and no-show extension (AA, once, reason), bulk allocation (select staff, auto-match, preview with conflicts, confirm, per-row result, retry-safe). Acceptance: AT-006, AT-007, AT-008, scope tests, SoD tests.

**WP-E Waitlist and offers:** create entry when no bed matches (queue position, 15-day expiry), priority exception (Policy Approver), renewal (AA, revalidates), queue and matching when a bed frees, offer creation holding the bed (`offer_hold` claim), delivery confirmation (viewed, email-confirmed placeholder, offline), accept (claim becomes the reservation's), decline (first keeps position, second requeues), accept on behalf with consent, withdraw, and the sweeps for reminders, expiry, offer expiry and the 24 h unseen follow-up. Acceptance: AT-009, 010, 011, 012, 013, 030.

**WP-F Check-in, stay, transfer, extension, checkout:** check-in (single and bulk) with revalidation; no-show sweep and arrival expectations; stay list and detail; transfer and swap, atomic, destination locked before source released (AT-022); extension within and beyond policy with conflict offering a transfer; voluntary checkout request and processing (bed to Needs cleaning); end-date reminder and overdue sweeps (flag and escalate, never check out). Acceptance: AT-022, plus atomicity, concurrency and SoD tests.

**WP-G Emergency check-in:** initiate (capability only), provisional stay with a claim, approver routing by initiator role, approve (never the initiator, AT-017), reject with reason creating a relocation task owned by AA (AT-018), 24 h and re-alert sweeps, escalation after two unanswered (AT-016), 24 h deadline reminder (AT-015), screens. Acceptance: AT-015, 016, 017, 018.

**File ownership**

| Area | Owner |
|---|---|
| `src/server/allocation/**`, `eligibility/**`, `notify/**`, `jobs/**`, `approvals/**` (framework), `config/registry.ts`, `command/**`, `auth/**`, `src/ui/**`, `app-nav.ts` framework, `app-my.ts` framework, `tests/api/fixtures2.ts` | WP-0 (read-only for the others; report gaps) |
| `src/server/commands/{requests,approvals,allocation-admin}/**`, `queries/requests/**`, `app/api/v1/requests/**`, `app/api/v1/approvals/**`, `app/(app)/{requests,approvals}/**`, `tests/api/requests/**`, migrations 0050–0059, `schema.requests.ts` | WP-D |
| `.../commands/waitlist/**`, `queries/waitlist/**`, `app/api/v1/waitlist/**`, `app/(app)/waitlist/**`, `tests/api/waitlist/**`, 0060–0069, `schema.waitlist.ts`, sweeps `jobs/sweeps/waitlist*.ts` | WP-E |
| `.../commands/stays/**`, `queries/stays/**`, `app/api/v1/stays/**`, `app/(app)/stays/**`, `tests/api/stays/**`, 0070–0079, `schema.stays.ts`, sweeps `jobs/sweeps/stays*.ts` | WP-F |
| `.../commands/emergency/**`, `queries/emergency/**`, `app/api/v1/emergency/**`, `app/(app)/emergency/**`, `tests/api/emergency/**`, 0080–0089, `schema.emergency.ts`, sweeps `jobs/sweeps/emergency*.ts` | WP-G |
| `policy.ts`, nav, "my" sections, approval sources, sweep registrations | shared: append inside the package's marked block only |

## 5. Test strategy

Same as Stage 1: API-level tests with the harness against real PostgreSQL as `app_role`, acceptance tests named after SRS ids, the contract test, Playwright smoke per package, plus:

- **Sweep tests** with `FixedClock`: advance to just before and just after every boundary (15 d, 48 h, 24 h, 1/2/3 business days, 24 h emergency, second unanswered reminder), run the sweep twice and from two concurrent runners, assert the effect happened once.
- **Concurrency**: two approvals for the same bed, two offers for the same bed, two check-ins for one reservation, transfer into a bed taken a moment earlier: exactly one winner, loser gets a conflict with a next action, nothing half-done.
- **No automatic decisions**: for each timer, a test that after the boundary no request, transfer, extension or emergency changed status and no resident moved.

## 6. Definition of done

As Stage 1: gate tests green in CI; contract test green; typecheck and lint clean; every screen has owner role, scope, validation and failure path; blocked states show reason, owner and next action; nothing OPEN hard-coded; README and the status table updated.

## 7. Proved by tests (beyond the acceptance ids)

1. A bed never has two live claims for overlapping dates, whichever command creates them (property test over randomized command sequences).
2. A failed transfer or swap leaves both residents exactly where they were (state, claims, keys untouched).
3. Same-day turnover works: departure on day D frees the bed for an arrival on day D.
4. A held bed (pending offer) cannot be allocated by any command until the offer resolves.
5. Readiness gates check-in only: a reservation can be made on a Needs cleaning bed, check-in on it is refused with reason, owner and next action.
6. Retried commands and sweeps are idempotent (AT-030).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Four packages each re-implement allocation | Single `allocateBed()` and claims service in WP-0; packages may not insert into `bed_claim` directly (a lint-style test greps for it). |
| Sweeps decide for people | The sweep API only exposes remind, escalate, expire-hold; review of each sweep against the "never decide" invariant; no-decision tests per timer. |
| Request/site scope is wrong | S-12 raised now; column is cheap to change before data exists. |
| Time zones and business days | Sweeps use the site calendar from configuration (G-01 open: Mon to Fri, UTC default, placeholders). |

## 9. Status

| Package | Status |
|---|---|
| WP-0 Allocation core | Done (migration 0040, allocation, eligibility, notify, sweeps, approvals framework, fixtures, tests) |
| WP-D Requests, approvals, allocation | Not started |
| WP-E Waitlist and offers | Not started |
| WP-F Check-in, stay, transfer, extension, checkout | Not started |
| WP-G Emergency check-in | Not started |

## 10. Recipe for work packages D to G (WP-0 as built)

Read `docs/STAGE-1.md` section 9 first (migration, schema file, command, query, route, page, tests: unchanged), then this section for what Stage 2 adds.

**Allocation: never write `bed_claim` yourself.** `src/server/allocation`: `allocateBed(c, {...})` creates a claim after locking the bed, checking physical state, eligibility (and recording exceptions via `recordExceptionUse` from `src/server/eligibility`), held beds and overlaps, and answers conflicts with `detail.reason` (`bed_taken`, `bed_held`, `bed_unavailable`, `bed_not_ready`, `not_eligible`, `has_reservation`), `owner`, `next` and `detail.suggestions`. `convertClaim` (offer_hold to reservation on accept, reservation to stay on check-in), `releaseClaim`, `setClaimPeriod` (extension) are the other writers. To move someone (transfer, swap) **release the old claim first in the same transaction, then allocate**; there is deliberately no "ignore this claim" option. `tests/api/core2/boundary.test.ts` fails if any other file inserts or updates `bed_claim`. Readiness: pass `requireReady: true` only for check-in (D-18, D-59).

**Eligibility**: `checkEligibility(q, staffId, bedId, now, { requestId })` for pre-checks and screens; `eligibility_exception` rows (Policy Approver, reason and evidence mandatory) are created by WP-D's exception command and used automatically.

**Notifications**: `notify(tx, { dedupeKey, kind, to: { staffId } | { role, siteId? }, text, ref })` inside the command's transaction. Build the key from the event (`offer:${id}:created`), never from the clock, so a retry or a second sweep creates nothing new (AT-030). `to.role` may be a role or a capability name. Never let a notification decide anything or fail a command.

**Approvals**: describe each pending decision as an `ApprovalDraft` (site, subject staff ids, who raised it, deciders per level with the policy action and who to remind) and register an `ApprovalSource` (`registerApprovalSource`) with one import line inside your block of `src/server/approvals/sources.ts`. The inbox (`listInbox`) and the reminder sweep are then automatic: scope, SLA clock, separation-of-duties "why you can't approve", reminders, backup routing and escalation. Sources with an hours-based clock (emergency) pass `ownClock` and run their own sweep.

**Sweeps**: `registerSweep({ name, description, run(ctx) })`, one import line inside your block of `src/server/jobs/sweeps/index.ts`. Use `systemTx(ctx, tx => ...)` **per item** (one bad row never blocks the others) and `auditSystem(...)` for the audit row. A sweep may remind, escalate, expire an entry or offer and release its hold, expire a no-show hold. It may **never** approve, reject, move or check out anyone. Every step must be safe to run twice: check the state under a row lock (`.for('update')`), use dedupe keys. Read time only from `ctx.now`. Test sweeps with `FixedClock` and `runSweep(name, clock)`.

**Resident screens**: add your section to `/my` through `src/app-my.ts` (one import, one array entry, in your marked blocks); nav entries in your block of `src/app-nav.ts`.

**Tests**: `tests/api/fixtures2.ts` (staff, requests, claims, exceptions, config values, `day()`), `tests/api/rc.ts` (call commands directly), `tests/api/property/helpers.ts` (`mkProperty`, `reserve`, `occupy`, `actor`, `send`). Name acceptance tests after SRS ids. For every timer: a test just before the boundary, one just after, one running the sweep twice and concurrently, and one asserting nothing was decided for a person.

**Schema from WP-0 you can rely on**: `accommodation_request.site_id` and `waitlist_entry.site_id` (required), request status `changes_requested`, `request_dates` (end after arrival), `notification`, `sweep_run`, `eligibility_exception`, `eligibility_exception_use`. Registry keys: `eligibility.*`, `timers.*` (waitlist, offer, emergency, SLA, no-show, reminders, overdue grace), `stays.*`.
