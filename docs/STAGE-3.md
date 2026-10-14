# Stage 3 plan: Clearance and readiness

Grand Hyatt Staff Accommodation Platform · production app (`platform/`) · 14 Oct 2026

Stage 3 of `PLAN.md` section 13. Exit gate: **AT-019, 020, 021, 032** pass against the real API and a real PostgreSQL, plus the permission contract test, no open severity-1 defects, and every item in section 7 green. Method as in Stages 1 and 2: the lead builds the shared core first (WP-0), three packages run in parallel in isolated worktrees with fixed file ownership and migration ranges, and the lead merges and verifies the gate.

## 1. Scope

**In:** Mark as Left (single and bulk with preview) with immediate login revocation and the cascade of D-36; clearance cases with a configurable checklist, items generated for every key and asset still held, completion on the former employee's behalf with audit attribution, the Policy Approver waiver, closing rules; keys and assets (issue, return, lost, damaged, replacement, overdue); cleaning tasks, housekeeping assignment, the cleaning checklist, final inspection and the release of the bed to Available; attachments (evidence for waivers, damage, failed inspections); rehire (reactivating the existing profile); re-confirmation of the password on high-risk actions (D-03); the sweeps for overdue clearances, keys and cleaning; screens, phone-first for Housekeeping and Reception.

**Out (later stages):** work orders and "resolved is not verified" (Stage 4; Under maintenance beds stay a Stage 4 concern), contractor and visitor passes cancelled on Mark as Left (Stage 4 adds its hook), email delivery and dashboards (Stage 5), migration import of outstanding keys (Stage 6, D-88).

**Open and built as configuration or placeholders:** key model for shared rooms (D-72: item types are configuration, a room key and a bed locker key are both supported); future-dated exit login policy (D-37: `exit.login_revocation` defaults to immediate, the D-35 rule, marked open); periodic inspections (D-75: not built); housekeeping owner and assignment (GH-18: Reception assigns, Final Inspection holders inspect); retention of personal data and attachments (GH-11: nothing is ever deleted; a retention policy is a Stage 6 question); clearance due date and overdue grace (placeholders); cleaning SLA (placeholder).

## 2. Design decisions

| Topic | Decision |
|---|---|
| Three different things | Checkout, clearance complete and bed ready stay separate records with separate states (D-64). **Mark as Left never frees a bed**; only an actual checkout releases the stay's claim, and only a passed final inspection makes the bed Available. `closed` means clearance is complete. A stay becomes `closed` only when it is checked out, something has cleared it (its clearance case is Cleared) **and** nothing is outstanding (no key or asset still held against that stay). A voluntary checkout has no clearance case and stays `checked_out`: its history is kept and nothing pretends a clearance happened. One function, `closeStayIfDone()` (`src/server/stays-close.ts`, with registered closers and blockers), decides, and is called from checkout, return of an item and clearance close: whichever finishes last closes the stay. |
| Mark as Left | One transaction: employment status Left with effective date and reason, login account revoked and **all sessions revoked at once** (`revokeAllSessions`), waitlist entries closed and offers withdrawn (`closeEntriesForStaff`, `withdrawOffersForStaff`), future reservations cancelled and their claims released, open requests, transfers, extensions and checkout requests cancelled, a pending emergency case converted into the clearance case (`convertEmergencyForExit`), clearance case opened, the stay flagged, Policy Approver and clearance owner notified (D-38). Refused for oneself (D-26) and for the last active Super Admin (D-27, `lastSuperAdminFailure`). Re-confirmation with the actor's password (D-03). The effective date is recorded; revocation is immediate regardless (D-37 open, configurable later). |
| Re-confirmation | `confirmPassword()` in the core: the actor's own password, checked inside the command; wrong attempts are counted and throttled like sign-in (the failed attempt persists although the command rolls back). Applied now to Mark as Left, bulk exit confirm, clearance waiver and rehire. Retrofitting role changes and emergency initiation is a question (S-18). |
| Clearance | Statuses Open, In progress, Pending items, Cleared (SRS 7). Items come from the configured checklist plus one item per key or asset still held. Each item has an owner role (Reception, Maintenance, Accommodation Admin), mandatory or not, and a status Open, Done, Waived, Outstanding. The case **stays open after login revocation**; an authorised admin completes items on the person's behalf and the actor and the "on behalf of" are recorded. A case cannot close while a mandatory item is Open or Outstanding, except through the **waiver**: Policy Approver only (`exit_clearance.waive`), reason and evidence (attachment) mandatory, re-confirmed, audited. A lost or damaged key is never marked returned (D-73): the item stays Outstanding with its owner until it is resolved or waived. |
| Keys and assets | One table of handover items (category key or asset, configurable item types, code, site, optional room and bed, holder), an append-only event log (issued, returned, lost, damaged, retired, replaced, found). Lost or damaged is a state, not a return; replacement retires the old item and links the new one (D-73). Overdue is computed (held after the stay ended, or past a due date), never a status that can be forgotten. Night Keys holders may issue and return any time; Reception too (an "out of hours" rule needs an answer, S-19). Transfers leave keys issued to the person and flag them for return and reissue (D-61). |
| Cleaning and readiness | Every transition of a bed to Needs cleaning (checkout, transfer source, unblock) opens one cleaning task (`openCleaningTask`, idempotent: one open task per bed). Reception or SA assigns it to a Housekeeping capability holder in scope. The housekeeper completes the checklist (results recorded) and the bed moves to Inspection required; cleaning alone never makes it Available. A Final Inspection holder inspects: pass makes the bed Available and tells the Admin who is next on the waitlist (`notifyFreedBed`), fail returns it to Needs cleaning with a new task. **Nobody cleans or inspects their own room** (their own bed's room), and the inspector is never the cleaner (D-26). Under maintenance is Stage 4. |
| Attachments | `attachment` table plus a storage interface (local disk now, behind `AttachmentStore`; object storage later). JSON upload (base64, 5 MB, PNG, JPEG, PDF, content sniffed not trusted), SHA-256 recorded, permission of the owning entity decides who may view, download with `nosniff` and `attachment` disposition, never deleted. Entity types register themselves with the viewer rule. |
| Timers | Sweeps only remind and escalate: overdue clearance (AA, then Policy Approver), overdue keys (Reception, then AA), unassigned or stale cleaning (Reception). They never close a case, mark a key returned, or mark a bed ready. |
| Permission contract | Unchanged: every route declares access and is covered by the generated contract test. |

## 3. Schema additions

| Range | Owner | Adds |
|---|---|---|
| 0090–0099 | WP-0 | `attachment`; `handover_item`, `handover_event`; `cleaning_task` (the table and the hook that fills it; WP-J extends it) |
| 0100–0109 | WP-H | `clearance_case`, `clearance_item`, rehire record if needed, bulk exit batch tables |
| 0110–0119 | WP-I | anything keys and assets need beyond the core tables |
| 0120–0129 | WP-J | cleaning checklist results, inspection records beyond the core columns |

## 4. Work packages

**WP-0 Stage 3 core (lead, first):** migration 0090 and schema; `confirmPassword()`; the attachment service, store, target registry and routes; `route()` support for file downloads (`FileDownload`); `openCleaningTask()` wired into checkout, transfer and unblock; `closeStayIfDone()`; `outstandingHandovers()` query; dependency checkers for handover items and cleaning tasks in the archive check; registry keys; navigation blocks; test fixtures; docs.

**WP-H Exit, clearance and rehire:** Mark as Left (single, bulk with preview and per-row result), the cascade, clearance cases and items, completion on behalf, waiver, closing, rehire (AT-032), screens (`/exits`, `/exits/[id]`), overdue sweep, the approval source for waivers if modelled as a request. Acceptance: AT-019, AT-020, AT-032.

**WP-I Keys and assets:** item registry per site, issue and return (Reception, Night Keys holders), lost and damaged with evidence, replacement with the link, overdue sweep, keys on the stay page and in the check-in follow-up, the transfer key flag, listing by person, bed and status, the archive check, screens (`/keys`). Acceptance: lost key never returned (D-73), replacement retires the old key, overdue after departure, concurrency (two issues of one key).

**WP-K Cross-site transfers (D-104, small):** the Stage 2 transfer and swap commands allow only the same site; the product owner decided transfers may cross sites. Source-site AA and destination-site AA both approve, eligibility is revalidated at the destination, execution stays atomic. Acceptance: AT-022 still passes, plus the cross-site proofs in its brief.

**WP-J Cleaning, inspection and readiness:** assignment, the checklist, cleaned, final inspection pass and fail, release to Available with `notifyFreedBed`, the readiness board (bed by state, owner and next action), phone-first Housekeeping screens (`/housekeeping`), the cleaning reminder sweep. Acceptance: AT-021, SoD (cleaner, inspector, own room), concurrency.

**File ownership**

| Area | Owner |
|---|---|
| `src/server/auth/reauth.ts`, `attachments/**`, `readiness/hooks.ts`, `stays-close` helper, `handover/outstanding.ts`, `http.ts`, `config/registry.ts`, `command/**`, `src/ui/**`, nav/my framework | WP-0 (read-only for the others; report gaps) |
| `commands/exit/**`, `queries/exit/**`, `app/api/v1/exit/**`, `app/(app)/exits/**`, `tests/api/exit/**`, 0100–0109, `schema.exit.ts`, `jobs/sweeps/exit*.ts` | WP-H |
| `commands/keys/**`, `queries/keys/**`, `app/api/v1/keys/**`, `app/(app)/keys/**`, `tests/api/keys/**`, 0110–0119, `schema.keys.ts`, `jobs/sweeps/keys*.ts` | WP-I |
| `commands/readiness/**`, `queries/readiness/**`, `app/api/v1/readiness/**`, `app/(app)/housekeeping/**`, `tests/api/readiness/**`, 0120–0129, `schema.readiness.ts`, `jobs/sweeps/readiness*.ts` | WP-J |
| `commands/stays/**`, `queries/stays/**`, `app/api/v1/stays/**`, `app/(app)/stays/**`, `tests/api/stays/**` (cross-site transfer changes only), migration 0130–0139 | WP-K |
| `policy.ts`, nav, "my" sections, approval sources, sweeps | shared: your marked block only |

## 5. Test strategy

As Stage 2: API-level acceptance tests named after SRS ids, the contract test, Playwright smoke per package, sweep tests with `FixedClock` (before, after, twice, concurrently), concurrency tests, "no automatic decision" tests, plus the cross-package journeys in `tests/api/integration` (section 7). Each package's e2e uses its own seeded people (the shared database lesson of Stage 2).

## 6. Definition of done

As before: gate tests green in CI; contract test green; typecheck and lint clean; every screen has owner role, scope, validation and failure path; blocked states show reason, owner and next action; nothing OPEN hard-coded; README and the status table updated.

## 7. Proved by tests

1. Mark as Left: login and every existing session dead on the very next request; the bed and stay untouched; waitlist and offers closed; future reservations cancelled; clearance case opened (AT-019).
2. Clearance completes on the person's behalf with actor and checklist history retained; cannot close with a mandatory item open; the waiver needs a Policy Approver, reason, evidence and re-confirmation (AT-020).
3. Checkout complete but cleaning or inspection not: the bed stays Needs cleaning or Inspection required and cannot be allocated, offered or checked into (AT-021).
4. Rehire reuses the profile, never creates a second active one, and is blocked by an open clearance unless waived (AT-032).
5. A lost or damaged key is never returned; replacement retires the old key.
6. The full exit journey: check-in, keys issued, Mark as Left, checkout, keys returned, clearance closed, stay closed, cleaning, inspection, bed Available, next waiting resident offered.
7. Sweeps remind and escalate only; nothing closes, returns or releases by itself.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Mark as Left half-done | One transaction; a test forces a failure at each step and asserts nothing changed. |
| A bed marked ready without inspection | Only one function writes `inspection_required` to `available`, requires a passed inspection by a Final Inspection holder; an allocation-style boundary test greps for any other writer. |
| Attachments as an attack surface | Type sniffing, size cap, `nosniff`, download only through the permission check, no execution path; malware scanning noted for Stage 6 (penetration test). |
| Evidence and personal data retention (GH-11) | Nothing deleted; flagged to Grand Hyatt; storage behind an interface. |

## 9. Status

| Package | Status |
|---|---|
| WP-0 Stage 3 core | Done (migration 0090, re-confirmation, attachments, cleaning hook, stay closing, handover query, archive checkers) |
| WP-H Exit, clearance, rehire | Done: migration 0100, Mark as Left (single and bulk), cascade, clearance cases and items, completion on behalf, waiver (writes the key off), close, rehire, overdue sweep, screens |
| WP-I Keys and assets | Done: registry, issue, return, lost, damaged, found, retire, replace, overdue (computed), sweep, screens, keys panel on the stay page |
| WP-J Cleaning, inspection, readiness | Done: assignment, checklist, final inspection (the only writer of Available), board, housekeeper phone screens, reminder sweep |
| WP-K Cross-site transfers (D-104) | Done: migration 0130, two-key approval, destination revalidation, atomic execution, follow-up hooks, screens |
| Integration | Real-command exit journey (`tests/api/exit/journey.test.ts`); keys panel mounted on `/stays/[id]`; Mark as Left and Rehire buttons on the staff profile |
| Exit gate | See section 12 |

## 10. Recipe for work packages H to K (WP-0 as built)

Read `docs/STAGE-1.md` section 9 and `docs/STAGE-2.md` sections 10 and 11 first; they still apply. What Stage 3 adds:

- **Re-confirmation (D-03):** `confirmPassword(c, input.confirmPassword)` from `src/server/auth/reauth.ts`, called early inside the command before any write; add `confirmPassword: z.string().optional()` to the input (the command refuses a missing one with a field error). Wrong attempts are throttled and persist although the command rolls back.
- **Attachments:** `registerAttachmentTarget({ entityType, load, canAttach, canView })` (one import in your block of `src/server/attachments/targets.index.ts`); upload and download go through `/api/v1/attachments` (JSON base64, PNG/JPEG/PDF, 5 MB, sniffed). The record's own permission decides who sees a file. A command that needs evidence (waiver, damage, failed inspection) takes `attachmentIds` and checks that they exist on that record.
- **Cleaning:** never set a bed to Available yourself. `openCleaningTask(tx, { bedId, reason, now })` is called wherever a bed becomes Needs cleaning (already wired into checkout, transfer source and unblock); the only writer of `inspection_required` to `available` is WP-J's final inspection (a test greps for any other).
- **Stay closing:** `registerStayCloser(id, fn)` (WP-H: the stay's clearance case is Cleared) and `registerStayCloseBlocker(id, fn)`; call `closeStayIfDone(tx, stayId, now)` after anything that could finish the last outstanding thing.
- **Handover items:** tables `handover_item`, `handover_event` (append-only) and `outstandingHandovers(db, staffId)`; WP-I owns the commands, WP-H reads them for clearance items.
- **No deletion** still: archive, release, retire. Lost or damaged is never "returned".
- **Archive checkers** for outstanding items and open cleaning exist already in `src/server/commands/property/dependencies.ts`.
- **Fixtures:** `tests/api/fixtures3.ts` (items, stays, cleaning tasks, PNG/JPEG/PDF bytes) on top of `fixtures2`.
- **Mark as Left cascade helpers** (call them from WP-H, do not re-implement): `closeEntriesForStaff`, `withdrawOffersForStaff` (waitlist), `convertEmergencyForExit` (emergency), `revokeAllSessions` (auth), `lastSuperAdminFailure` and `lockSuperAdmins` (access), `releaseClaim` (allocation), `notSelf` (command).

## 11. Common brief for work packages H to K

Same as `docs/STAGE-2.md` section 11 (read-first list, environment, rules, report format) with these changes: the Stage 3 plan and recipe are sections 1 to 10 of this document; seeded e2e people are the same plus residents E1301 and E1302 (already used by Stage 2 specs: **create your own people in your e2e spec** with the pattern in `tests/e2e/requests.spec.ts`, never reuse a seeded resident); give your Playwright smoke the unique port named in your brief; `tests/api/fixtures3.ts` is the fixture base; shared e2e data lives in one database so your spec must not depend on being alone (pick your own bed from your own room, filter by names you created). Your final run must include the complete `npx playwright test` (all specs), not only yours.

## 12. Exit gate result (14 Oct 2026)

Merged branch, real PostgreSQL 16, application connected as `app_role`:

| Check | Result |
|---|---|
| `tsc --noEmit`, `next lint`, `next build` | clean |
| Vitest (81 files) | 1331 passed, 0 failed, no unhandled errors |
| Acceptance tests by name | AT-019, 020, 032 (WP-H); AT-021 (WP-J); AT-029 extended (keys held, open cleaning); AT-022 still green with cross-site transfers (WP-K) |
| Section 7 proofs | 1 to 7 covered; proof 6 runs the real command of every package in one journey |
| Permission contract test | green with every Stage 3 route |
| Playwright smoke | 29 passed in one run on one database (auth, property, staff, access, requests, waitlist, stays, cross-site, emergency, exit, keys, readiness) |
| Severity-1 defects | none known |

**Seams fixed at merge:** a waived lost key is written off so the stay can close; keys panel, Mark as Left and Rehire buttons wired in; approval kind labels; every e2e spec uses the run's own database and its own people; fixtures follow the new `destination_site_id` column; `data/` ignored.

**Carried forward:** Stage 4 must call `openCleaningTask` when work finishes; visitor and contractor pass hooks for Mark as Left and cross-site moves; archive of a staff profile does not yet check for an open clearance case; D-75 periodic inspections; retention policy (GH-11). Open questions S-14 and S-18 to S-22 in `docs/PLAN.md`.
