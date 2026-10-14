# Gap Analysis: 14 Oct 2026

Grand Hyatt Staff Accommodation Platform · Phase 1 · Adpedia

This review compares four things and says what is missing, what conflicts, and what to do about it:

| Ref | Input | Where |
|---|---|---|
| **FPD** | *Full Project Document v1.1* (Word). The SRS v1.0 body plus two appended sections: §20 permission matrix and §21 approval tree. The cover still says "Version 1.0". | `docs/source/Grand_Hyatt_Full_Project_Document_v1.1.docx` |
| **HP** | *HTML prototype* from another effort: a single 3,000-line vanilla-JS file, admin portal plus resident app, `localStorage`, a built-in "journey guide". | `docs/source/external-html-prototype.html` |
| **DL** | Our decision log, permission matrix and approval routes (D-01 to D-101). Overrides the FPD wherever they conflict. | `docs/DECISIONS.md`, `PERMISSIONS.md`, `APPROVALS.md` |
| **NP** | Our Next.js clickable prototype. | `prototype/` |

Method: read the FPD in full; diffed it against the SRS already in the repo; read the HP's data model, rules, request flow and screen list and searched it for every Phase 1 capability; ran the NP's 32 scenario tests and mapped them to the SRS acceptance tests AT-001 to AT-032.

---

## 1. What matters most

1. **The FPD adds no new requirements.** It is the SRS plus the older permission matrix (§20) and approval tree (§21). Those two sections predate the Policy Approver decision (D-25) and conflict with the decision log in ten places (section 2). The specification set needs one merged, current version.
2. **The specification still has real holes.** The seven release blockers in SRS §18.1 are known. This review found **27 further gaps** (section 3). Seven of them block a correct Stage 1 or Stage 2 build, but all have a proposed default, so none needs to stop the work.
3. **The HTML prototype is not a Grand Hyatt build.** It models a generic Dubai staff camp with eight roles, line-manager approvals, WhatsApp and Firestore. It covers inventory, allocation, maintenance, keys and a basic approval flow, but not the waitlist, emergency, clearance, readiness or security flows, and it conflicts with eight decisions. It does contain ten ideas worth adopting (section 4).
4. **Our prototype covers all Phase 1 flows but is a demo.** After the hardening pass all 32 acceptance tests are verified against its business rules (section 5), plus delegation, grants and maker-checker. It has no server, so none of its permission checks is a security boundary yet.
5. **The hardest requirements are invariants, not screens.** No double allocation, immediate login revocation, append-only audit, atomic transfer. They should be enforced by the database, not only by application code. That drives the main technical recommendation in `PLAN.md`: **PostgreSQL**, not the Firestore the HTML prototype assumes.

---

## 2. Conflicts between the FPD and the decision log

The decision log wins. Each row says what the FPD says, what we decided, and what to change in the FPD.

| # | FPD says | Decision log says | Action |
|---|---|---|---|
| C-1 | §21: **Super Admin** decides waitlist-priority exceptions, beyond-policy extensions, gender and grade exceptions, and is the backup for most routes. | D-25: a business **Policy Approver** takes policy and exception decisions. SA keeps system configuration. | Replace SA with PA in §21 (`APPROVALS.md` already does). |
| C-2 | §4: hierarchy is Site → Building → **Floor → Unit** → Room → Bed. | D-12: Floor and Unit are **optional**. A villa can be Site → Room → Bed. | Amend §4, §5.1. |
| C-3 | §6: Stay states start with **Reserved**. | D-43: Request, Reservation and Stay are separate records. | Remove "Reserved" from the Stay row. |
| C-4 | §6: **Reserved** is a Bed state. | D-17: bed has a physical state. Reservations are date-ranged records alongside it. | Amend §6. Reports derive "Reserved" from reservations. |
| C-5 | §21: "Bed allocation/reservation **execution**" is a separate AA step after approval. | D-44: approval selects the bed and creates the reservation in one atomic step. | Merge the two rows. |
| C-6 | §11 and **AT-021**: not-ready beds "cannot be allocated". | D-17/D-18: readiness gates **check-in and offers**, not a reservation for a later date. | Reword AT-021: "cannot be checked into or offered". |
| C-7 | §8, **AT-016**, §21: emergency escalates to the Super Admin; AA-initiated goes to SA. | D-68: Rec-initiated → AA; AA-initiated → PA; escalation → backup, then PA/SA. | Amend §8, AT-016. |
| C-8 | §4.1: hard deletion by SA after a 30-day restore window. | D-40: no deletion, ever. (The FPD flags this itself.) | Remove. Add an anonymisation procedure only if GH legal requires it (G-27). |
| C-9 | §3.1 lists grantable capabilities: "key supervisor, inventory supervisor, facility manager, maintenance coordinator…". §20.1 lists a different set. | D-log list: Housekeeping, Final Inspection, Emergency Check-in, Building Creation, Night Keys, Backup Approver, Policy Approver, Outage Export, Staff Master. | Use the D-log list. Inventory is out of scope (D-11). Key supervisor needs a GH answer (G-24). |
| C-10 | §5.3 step 14: approval path "if any". | D-45: no auto-approval of any request category. | Remove "if any". |

Also reconciled earlier in `PERMISSIONS.md`: §20 lets AA "Mark ready", but D-24 allows only an authorised inspector (Final Inspection capability).

**Recommendation:** regenerate the SRS as **v1.2 from the decision log** and retire v1.0 and the v1.1 appendices, so there is one current document and one change history.

---

## 3. Gaps in the specification

Severity: **Blocker** = cannot build correctly without an answer or an agreed default · **Needed** = must be settled before the stage that uses it · **Later** = can follow.
Every gap has a proposed default so work can proceed. Defaults are placeholders until Grand Hyatt confirms.

### 3.1 Already known (SRS §18.1 release blockers, unchanged)
Eligibility matrix and exception owner (GH-03) · emergency approval chain (GH-07, GH-19, GH-20) · SOS recipients and fallback (GH-08) · retention and privacy policy (GH-11) · bed-capacity baseline (GH-02, D-89) · outage-reconciliation owner (GH-12) · contractor-access owner (GH-09).

### 3.2 Newly found

| # | Gap | Why it matters | Proposed default | Stage | Severity |
|---|---|---|---|---|---|
| G-01 | **Business calendar and time zone.** "Business days", "24h after arrival date" and "day 1 overdue" need a clock basis. Working week, public holidays and site time zone are unspecified. | SLA, reminder and no-show logic cannot be exact. | Site time zone setting; Mon–Fri week and holiday list, both editable. Store UTC, display site-local. | 1 | Blocker |
| G-02 | **Approval policy versioning and re-routing.** FPD says approvers must be reassigned when deactivated, but not how in-flight items behave when routes change. | Inconsistent decisions; stuck approvals. | In-flight items keep the route version they started under. Deactivating an approver first reassigns their items. | 2 | Blocker |
| G-03 | **Approval engine shape.** Fixed routes with named approvers (DL) versus a configurable multi-stage workflow designer (HP; FPD "workflow publish" implies one). | Determines the data model and cost. | Fixed route types from `APPROVALS.md`; configurable named approvers, SLAs, delegation. No visual designer in Phase 1. | 2 | Blocker |
| G-04 | **Delegation semantics (D-32).** Scope, overlap with separation of duties, and whether a delegate may act on items they would otherwise be blocked from. | Loophole for self-approval. | Delegate takes the approver's place for the dates; separation of duties still applies to the delegate; audited. | 2 | Blocker |
| G-05 | **Identity data and photos.** Security sees a "photo", but there is no HRMS and no photo field in the staff profile or CSV. What ID is checked at check-in, and is any ID number stored? | Privacy exposure; Security screen has no data source. | Optional photo uploaded by AA at onboarding; ID checked visually; **no ID numbers stored**. GH legal to confirm. | 1 | Blocker |
| G-06 | **Notification catalogue.** Events are listed, but not recipients, timing, templates, in-app inbox behaviour or deduplication keys. | AT-014 and AT-030 cannot be tested. | Event × recipient × channel × timing table in the plan; dedupe key = event + recipient + window. | 2 | Blocker |
| G-07 | **Definition of "confirmed email delivery" (D-51).** Provider "accepted" ≠ received. Staff without email exist. | Starts the 48h offer clock. | In-app view, provider delivery webhook, or recorded offline follow-up. "Accepted by provider" never starts the clock. | 2 | Blocker |
| G-08 | **Partial CSV import policy.** AT-005 refers to an "approved partial-import policy" that does not exist. | Behaviour of the import button. | Admin chooses all-or-nothing or valid-rows-only at confirm time; default valid-rows-only with a downloadable rejection file. The NP already does this. | 1 | Needed |
| G-09 | **Occupancy KPI definition (GH-16).** The design mock shows 92.4% beside 412 occupied of 510 (80.8%). | Reports that disagree with themselves. | Occupancy = occupied ÷ active beds; also show "ready and vacant" and "out of service". | 5 | Needed |
| G-10 | **Attachments and evidence.** Waiver evidence, damage photos, work completion, inspection photos (D-75). No file type, size, scanning, storage or retention rules. | Security and storage design. | Private object storage, signed URLs, images and PDF, 10 MB, malware scan, same retention as the parent record. | 3 | Needed |
| G-11 | **Account lifecycle values (GH-14).** Invitation expiry, lockout, session timeouts, first-login change, admin-assisted reset audit. | Authentication build. | Invite 72h; lock 15 min after 5 failures; admin idle 30 min, resident 12h; forced change at first login. Placeholders. | 1 | Needed |
| G-12 | **Request categories.** FPD has one generic request. The HP also models visitor overnight stays and family accommodation. | Scope creep or a missed requirement. | Out of Phase 1 unless GH confirms (ties to GH-10, GH-17). | 2 | Needed |
| G-13 | **Gender policy values.** The HP offers Male, Female, Mixed and Family rooms. The FPD says "strict configured compatibility" and "missing data blocks allocation". | Room master data and eligibility. | Room gender = Male / Female / Any. Staff gender required (Male / Female). Confirm with GH-03. | 1 | Needed |
| G-14 | **Emergency arrival with no staff profile.** Provisional stay assumes the person already exists, but arrivals at 2 a.m. may not. | Flow breaks in a real emergency. | Initiator with the capability may create a minimal profile marked Unverified in the same action; AA verifies afterwards. | 2 | Needed |
| G-15 | **Stay timers need events.** D-54 to D-56 (end reminders at 14/7/1 days, overdue day-1 flag, escalation after grace) are rules without notification specs. | Same as G-06. | Covered by the catalogue in G-06. | 2 | Needed |
| G-16 | **Auditor scope and manager export.** FPD leaves Auditor all-site access open and exports "only if granted" without a mechanism. | Permission model. | Auditor: all sites, read-only, export of audit evidence. Manager export is a time-limited, reasoned grant (D-22). | 1 | Needed |
| G-17 | **Report catalogue.** Report names and minimum data exist; filters, columns, formats and recipients do not. | Reporting build and acceptance. | Table in the plan; CSV + PDF; every report shows an "as of" time. | 5 | Needed |
| G-18 | **Non-functional numbers (NFR-10).** Users, volumes, uptime, recovery, browsers are all unset. | Sizing, hosting, test plan. | Planning basis: ≤ 1,500 residents, ≤ 50 concurrent users, 99.5% uptime, RPO 15 min, RTO 4 h, last 2 versions of Chrome/Edge/Safari/Firefox. Placeholders. | 1 | Needed |
| G-19 | **Key and asset model (D-72).** "Basic asset handover" and key cabinets are mentioned but not modelled. | Check-in and clearance screens. | Room key plus optional locker key; per-room asset checklist (no inventory, D-11). | 3 | Needed |
| G-20 | **Accessibility target.** The design system sets 4.5:1 contrast but the FPD has no accessibility requirement. | Compliance and QA. | WCAG 2.1 AA as NFR-13. | 1 | Needed |
| G-21 | **Languages.** Staff may not all read English; the FPD does not say. The HP assumes Dubai time zones. | Text externalisation from day one. | English only in Phase 1, all text in message catalogues so languages can be added. Confirm location. | 1 | Needed |
| G-22 | **Test data and environments.** No rule against production PII in UAT. | Privacy. | Synthetic data only outside production. | 6 | Needed |
| G-23 | **Support model.** Runbook and support are in Stage 6 but have no owner or hours. | Go-live readiness. | Named owner and hours agreed before Stage 5 ends. | 6 | Later |
| G-24 | **Key supervisor, inventory supervisor, facility manager** appear in FPD §3.1 only. | Possible missing roles. | Not needed unless GH asks. | 3 | Later |
| G-25 | **Line manager.** The HP puts "Line manager" as an approval stage; our DL treats it as a possible future group. | Approval routes. | Out of Phase 1 (D-25 note). | 2 | Later |
| G-26 | **Future-dated exit (D-37)** and **periodic inspections (D-75)** remain OPEN. | Staff and housekeeping logic. | Build behind configuration; default immediate revocation on the effective date. | 3 | Later |
| G-27 | **Data-subject erasure** under "never delete". | Legal exposure. | Design an audited anonymisation procedure only if GH legal requires it. | 6 | Later |

---

## 4. The HTML prototype

### 4.1 What it is
A self-contained web app (admin portal plus a resident app mode) with seed data for two generic sites ("Al Quoz Staff Camp", "Jebel Ali Village"), persistence in `localStorage`, and comments that say each operation becomes "a Cloud Function that runs in one Firestore transaction". It references a `firebase-data-design.md` that was not provided.

### 4.2 What it covers (checked in the code)
Sites, buildings, rooms, beds, room types, amenities · staff directory and CSV import · bed allocation with overlap checks, check-in and check-out checklists, transfers · four request types with a **multi-stage approval workflow** · maintenance tickets with a richer lifecycle · key register with incidents · users and roles admin · approval-route editor · reference-data admin · reports with CSV export · audit trail · notifications panel · a guided demo journey.

### 4.3 What it does not cover
Searched the file for each term; none were found: **waitlist, bed offers, provisional/emergency stays, housekeeping or readiness workflow, no-show handling, reminders and escalation, delegation, maker-checker, bulk allocation, migration import, outage export, SOS, visitor gate, contractor visit windows.** Staff have an employment status (active, notice period, on leave, terminated) with an end date, and a terminated person cannot get a new bed. But changing that status does **not** revoke the login or open a clearance case. Exit is modelled as a request type that schedules a check-out.

### 4.4 Where it conflicts with our decisions

| HP | Decision | Note |
|---|---|---|
| Eight roles (system admin, approver, key custodian…) | D-21: ten groups plus capabilities | Role model is different. |
| "Line manager" approval stages | G-25 | Not in Phase 1. |
| WhatsApp as a contact and notification channel (the HP itself marks it "Phase 2") | D-09: in-app and email only | Remove. |
| One allocation record with statuses draft / confirmed / checked-in | D-43: request, reservation and stay are separate | It conflates reservation and stay. |
| "Mixed" and "family" room policies; visitor-stay and family request types | G-12, G-13 | Not in the FPD. |
| Coral/teal Airbnb look, light only | D-91: Grand Hyatt red, light and dark | Different brand. |
| Firestore and Cloud Functions | D-101: backend not decided | Technical risk, see `PLAN.md`. |
| `localStorage` persistence, fixed "today" | D-100: demo only | Fine for a demo, not for build. |

### 4.5 Ideas worth adopting

| Idea (found in the HP) | Use |
|---|---|
| **"Approved, action failed" request state**: approval and execution are separate, and a failed execution is visible, not hidden. | Adopt: matches "Approval ≠ execution" in our journey review. |
| **"Changes requested → resubmitted"** loop with revision history. | Adopt as an approver action alongside approve and reject. |
| **Date-ranged bed blocks** with a reason (repair, cleaning, inspection, safety). | Adopt: our prototype only has an on/off block. |
| **Maintenance lifecycle**: waiting for resident / parts / access, resident confirmation, reopen window. | Adopt for work orders (Stage 4). |
| **Key register**: key kinds, custodian, lost / damaged / under repair / retired. | Adopt for the key model (G-19). |
| **Room types and amenities** (dorm, twin, single). | Adopt as optional room attributes. |
| **Approval policy version stored on each request**, with a self-approval flag. | Adopt (G-02). |
| **Reference-data admin** (departments, categories, teams). | Adopt as configuration. |
| **Employment statuses with an end date** (notice period, on leave). | Informs the open question on future-dated exit (D-37). |
| **Guided demo journey** with a checklist. | Adopt in our prototype for stakeholder walk-throughs. |

---

## 5. Our prototype (NP)

### 5.1 Coverage of the SRS acceptance tests

*Updated after the hardening pass (see `PLAN.md` section 12).* All 32 acceptance tests now have an automated test against the prototype's business rules (70 tests in total). These prove the rules; production must repeat them against the real API and database.

| Tests | Where |
|---|---|
| AT-003, 006 to 013, 015 to 022, 028 to 030 | `tests/scenarios.test.ts` (AT-021 under the D-18 reading, conflict C-6) |
| AT-001, 002, 031 (scoped reads, data minimisation, export control) | `tests/hardening.test.ts` |
| AT-004, 005 (CSV preview and partial import) | `tests/hardening.test.ts` |
| AT-014 (email failure, retry, "sent" is not "delivered") | `tests/hardening.test.ts` |
| AT-023, 024 (contractor gate and scope), AT-025 (SOS escalation) | `tests/hardening.test.ts` |
| AT-026, 027 (audited outage export, reconciliation), AT-032 (rehire) | `tests/hardening.test.ts` |

Also covered by new tests: delegation, capability grants with maker-checker, account revocation, structure blocking and archiving, date-ranged blocks, "changes requested", visitor flow, end-date reminders. Proposed new acceptance tests AT-033 to AT-035 are in `SPEC-AMENDMENTS.md`.

What the prototype still cannot prove: access control across a real network boundary (URL and API tampering), concurrent writers on a real database, and the behaviour of a real email provider. Those are Stage 1, 2 and 5 work.

### 5.2 Specified in the decision log: status after hardening

| Item | Reference | State |
|---|---|---|
| Delegation routing approvals | D-32 | **Built** |
| End-date reminders, overdue escalation | D-55, D-56 | **Built** (notifications generated once) |
| Voluntary-checkout acknowledgement | D-63 | **Built** |
| Visitor register and gate flow | FPD §13.1 | **Built** (hours are placeholders, GH-10) |
| Contractor accounts, visit windows, gate checks | D-76 | **Built** |
| Capability grants, accounts, maker-checker | D-22, D-27 | **Built** (with only two Super Admins a change to either stays pending, by design) |
| Invitation, activation, password reset | D-07, D-08 | Admin-assisted reset and forced change **built**; invitation email flow is Stage 1 |
| Room and building archiving, blocking cascade | D-19 | **Built** |
| Bulk exit with preview | D-38 | Not built |
| Date-ranged bed blocks | HP idea | **Built** |
| Asset handover, key cabinet | G-19 | Not built (key model still open, D-72) |

### 5.3 Placeholder content that must not reach production
- ~~National ID, static trends, fake contractor tile~~ **removed**: check-in now shows a photo-on-file flag (optional photo, no ID numbers stored, G-05); KPI tiles show real counts.
- Seed names, phone numbers, beds, vendors and visitors are dummy data.

### 5.4 Engineering limits
- It clones the whole state for every action. Fine for a demo, not for production.
- No server, so no real authentication, sessions or access control.
- No accessibility audit (focus handling in drawers and modals, screen-reader checks).
- No automated browser test per role.

---

## 6. Recommended next steps
1. Agree the **technical decisions** in `PLAN.md` section 3, above all the database (recommend PostgreSQL).
2. Send Grand Hyatt the **question list**: the 7 release blockers, plus G-05, G-12, G-13, G-18, G-21 and G-27.
3. Merge the decision log into **SRS v1.2** and retire the conflicting FPD sections.
4. Run **Stage 0** of the plan (decisions, scaffolding, CI, schema v0).
5. In parallel, **harden the prototype** with the items in `PLAN.md` section 12, so the sign-off demo shows every Phase 1 flow.
