# Stage 1 plan: Foundation

Grand Hyatt Staff Accommodation Platform · production app (`platform/`) · 14 Oct 2026

Stage 1 of `PLAN.md` section 13. Exit gate: **AT-001, 002, 003, 004, 005, 028, 029 pass** against the real API and a real PostgreSQL, plus the permission contract test and no open severity-1 defects.

## 1. Scope

**In:** sign-in and sessions; roles, scopes and capability grants with maker-checker; user accounts (admin-assisted); the audit writer and viewer; site → building → room → bed setup, blocking and archiving; staff profiles, duplicate check and CSV import with preview; configuration (calendar, time zone, timers, password and session policy); the screens for all of the above.

**Out (later stages):** requests, allocation, waitlist, check-in (Stage 2); Mark as Left, clearance, keys, housekeeping (Stage 3); work orders, contractors, visitors, SOS (Stage 4); email delivery, invitation links, reports (Stage 5). Mark as Left is Stage 3, but Stage 1 provides the "revoke every session for this user" function it will call.

**Decided here:** D-103 (departure-day end dates). **Open and built as configuration or placeholders:** password and session values (GH-14), calendar (G-01), eligibility matrix (GH-03: only a room gender policy and a placeholder grade rule exist), photos (G-05: the profile has no photo or ID-number field).

## 2. Design decisions

| Topic | Decision |
|---|---|
| Password hashing | **Argon2id** (`@node-rs/argon2`, prebuilt binaries). If it cannot install in an environment, Node's built-in `scrypt` with OWASP parameters is the fallback behind the same `hashPassword/verifyPassword` interface. |
| Password policy | Placeholder (GH-14): at least 10 characters, not equal to the username, not a trivially common password; stored in configuration. |
| Sessions | Opaque 32-byte random token in an `HttpOnly`, `SameSite=Lax`, `Secure` (production) cookie. Only the SHA-256 hash is stored. Idle and absolute expiry from configuration; **admin roles stricter than residents** (defaults 30 min idle / 12 h for SA, AA, Rec, MC, Sec, Aud, Mgr; 12 h idle / 7 d for residents and contractors, placeholders G-11). Every request checks the row, so revoking is an update. |
| CSRF | `SameSite=Lax` plus an `Origin`/`Sec-Fetch-Site` same-origin check on every state-changing request. |
| Lockout | 5 failed sign-ins lock the account for 15 minutes (placeholders). Failures never reveal whether the username exists. |
| First sign-in | `must_change_password` limits the session to "change password" and "sign out" until done. |
| Account activation | Admin-assisted (D-07, D-08): the admin creates the account and a temporary credential is shown **once**. Invitation links need email (Stage 5). |
| Actor | One **active mode** per session (S-2, D-96). A user with several role assignments picks which to act as. `Actor = { role, caps, sites, staffId }`: `sites` is the union of that role's site assignments (`'all'` for a global assignment); `caps` are the user's currently active capability grants. |
| Not found vs forbidden | Reading something outside scope returns **404** with no detail (AT-001, AT-002). Lacking the action entirely is **403**. |
| Commands | One function per business action in `src/server/commands/`. Every command validates (Zod), authorizes (`policy.decide`), checks separation of duties, runs in **one transaction**, writes the **audit event in the same transaction**, and returns a `Result` carrying reason, owner and next action on refusal (D-93). Known database errors (`23P01` overlap, `GH001` bad transition, `23505` duplicate) map to results, not 500s. |
| Reads | `src/server/queries/`: every query takes an `Actor` and applies `scopeFilter()` in SQL. Pages and the API both read through them. |
| API | JSON route handlers under `app/api/v1/…`, thin wrappers over commands and queries. UI pages are server components that call queries directly; forms and buttons call the API. |
| Audit | `audit(tx, ctx, { action, entity, before, after, reason, siteId })` inserts into `audit_event` (append-only by privilege and trigger). Reads are scoped by site (AA "own sites" needs a grant). |
| Configuration | Versioned `config_item` rows; the current value is the latest version. A typed registry (`src/server/config/registry.ts`) lists every key with its default, decision reference and status (decided / default / open). Nothing OPEN is hard-coded. |
| Errors and logs | Structured JSON logs with a request id carried into the audit row. No secrets or stack traces in responses. |

## 3. Schema additions

All in numbered migrations, each granting `app_role` only what it needs and never DELETE.

| Migration range | Owner | Adds |
|---|---|---|
| 0008 | core | `session.active_role`, `session.must_change` handling fields, `login_attempt` (for rate limiting by username and IP), seed of the configuration registry defaults |
| 0010–0019 | WP-A | anything property setup needs (for example `bed_block` for date-ranged blocks) |
| 0020–0029 | WP-B | `import_batch`, `import_row` |
| 0030–0039 | WP-C | anything user admin and configuration need |

## 4. Work packages

**WP-0 Core (done first, by the lead, before the others start):** auth and sessions, actor resolution, command and query framework, audit writer, configuration registry, result and error types, an HTTP-level test harness, the UI kit ported from the prototype, the application shell (sign-in, change password, navigation filtered by what the actor may do), a development seed script. **Why first:** every other package depends on it; building it once keeps the pattern identical.

**WP-A Property setup and inventory:** commands to create sites, buildings (SA, or AA with Building Creation inside their sites), rooms and beds (AA); block and unblock beds (with a reason, optionally date-ranged); archive beds, rooms, buildings with a **dependency check that lists what blocks it** (occupied, reserved, keys, open work orders; AT-029); queries and the "Sites & rooms" screens. Acceptance: AT-029, AT-002 for inventory, scope tests per role, archive never deletes.

**WP-B Staff and CSV:** staff create and edit with **duplicate rejection** on the normalised employee ID (AT-003), staff list and detail with **role-dependent minimum data** (Reception masked, Security identity only, Resident own record only; AT-001), CSV import in two steps (**preview commits nothing; confirm saves valid rows once and offers the rejected rows as a file with reasons**; AT-004, AT-005) with the formula-injection guard, and the screens. Acceptance: AT-001, 003, 004, 005 plus export/injection tests.

**WP-C Access, configuration and audit:** user account administration (create, temporary credential, reset, deactivate; SA for admin accounts, AA for staff accounts), role assignments and scope (SA only), capability grants and role changes with **maker-checker** (second Super Admin, last SA protected, expiry), the "revoke all sessions" function, configuration screens (calendar and time zone per site, timers, password and session policy), the audit log viewer (scoped; Auditor all sites), and the screens. Acceptance: AT-028 (no API can change or delete an audit row), maker-checker tests, session revocation test, configuration versioning test.

**File ownership** (to keep parallel work conflict-free):

| Area | Owner | Rule for others |
|---|---|---|
| `src/server/auth/**`, `src/server/command/**`, `src/server/audit.ts`, `src/server/config/registry.ts` (framework), `src/ui/**`, `app/(app)/layout.tsx`, `app/login/**` | WP-0 | Read-only for WP-A, B, C. If something is missing, say so in the report instead of editing. |
| `src/server/commands/property/**`, `src/server/queries/property/**`, `app/api/v1/property/**`, `app/(app)/sites/**`, `tests/api/property/**` | WP-A | |
| `src/server/commands/staff/**`, `src/server/queries/staff/**`, `app/api/v1/staff/**`, `app/(app)/staff/**`, `tests/api/staff/**` | WP-B | |
| `src/server/commands/access/**`, `src/server/queries/access/**`, `app/api/v1/access/**`, `app/(app)/{users,config,audit}/**`, `tests/api/access/**` | WP-C | |
| `src/server/policy.ts` | shared | Append-only: add an action only if the matrix (`docs/PERMISSIONS.md`) already grants it. Never loosen an existing grant. |
| Navigation entries | shared | Each package adds one entry to `src/app-nav.ts` in its own marked block. |

## 5. Test strategy

- Every command: unit/integration test against the real database, including the refusal paths and the audit row.
- **Permission contract test:** generated from `POLICY`, calls the real API for every role × action and asserts allow, 403 or 404 as the table says. A route without a policy entry fails the build.
- API-level acceptance tests named after the SRS ids (`AT-001 …`) so the exit gate is a filter on test names.
- Concurrency: two simultaneous create-staff with the same employee ID: exactly one wins.
- Browser end-to-end (Playwright, one smoke per package) at the end: sign in, create a site and room, import a CSV, see it in the audit log.
- CI runs typecheck, lint, migrate, all tests and build (already in place).

## 6. Definition of done

- All exit-gate tests green in CI; contract test green; typecheck and lint clean.
- Every screen has an owner role, scope, validation and failure path (FPD §19).
- Blocked states show reason, owner and next action.
- Nothing OPEN hard-coded; every configurable value is in the registry with its decision reference.
- Documentation: `platform/README.md` updated; this document's status table filled in.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Session and password handling done wrong | One module, unit tests for expiry, lockout, revocation, token hashing; no custom crypto beyond the hash library. |
| Parallel packages drift apart | WP-0 first; file ownership table; each package reports what it needed from the core. |
| Scope leaks through list queries | Repositories take the actor; contract test covers every list endpoint. |
| Argon2 binary unavailable on a build machine | Same interface with `scrypt` fallback, chosen by configuration. |

## 8. Status

| Package | Status |
|---|---|
| D-103 | Done |
| WP-0 Core | Done |
| WP-A Property | Done: migration 0010, 12 commands, scoped queries, 13 routes, Sites & rooms screens. Not built: room/building blocking, site archive |
| WP-B Staff and CSV | Done: migration 0020, staff commands and queries by role shape, import preview/confirm/rejected file, screens |
| WP-C Access, configuration, audit | Done: migration 0030, accounts with one-time temporary credentials, maker-checker role changes and grants, configuration versions, audit viewer. Not built: D-03 re-confirmation, reassigning requests of a deactivated maker |
| Exit gate (AT-001, 002, 003, 004, 005, 028, 029 + contract test) | See section 10 |

## 9. Recipe for work packages (WP-0 as built)

Read `platform/README.md` "Stage 1 core" first. A feature is these pieces, in this order:

1. **Migration** `db/migrations/00NN_*.sql` inside your range. `GRANT SELECT, INSERT, UPDATE` to `app_role` (never DELETE; `tests/db/app-role.test.ts` fails the build otherwise). Every table: uuid primary key, `created_at`, `archived_at` instead of delete.
2. **Drizzle table** in your own `src/server/db/schema.<pkg>.ts`, registered in its `TABLES_<PKG>` object (the schema-sync test compares every table and column with the migrated database).
3. **Command** in `src/server/commands/<pkg>/<verb>.ts`: export a Zod `input` schema and `async function verb(rc: RequestContext, input): Promise<Result<Out>>`. Body: `runCommand(rc, async c => { ... })`; inside, `const denied = authorize(c, 'module.action', { siteId }); if (denied) return denied` (src/server/command/authorize.ts: out of scope is 404, no grant is 403), `notSelf(...)` for D-26, do the writes through `c.tx`, then `await audit(c, { action: 'pkg.thing.verb', entityType, entityId, siteId, reason, before, after })`. Return `ok(data)` or a `fail.*`. Never throw for a business refusal; a failure result rolls the whole transaction back, audit row included. Lock the row you are about to change (`.for('update')`) when two admins could race.
4. **Query** in `src/server/queries/<pkg>/*.ts`: takes the `Actor`, builds the WHERE with `scopeSql(scopeFilter(actor, 'module.action'), { site: table.siteId })` from `src/server/queries/scope.ts`. Never return rows the actor may not see, and never fetch then filter.
5. **Route** `app/api/v1/<pkg>/.../route.ts`: `export const POST = route({ name: 'pkg.verb', access: { kind: 'action', action: 'module.action' }, body: inputSchema, handler: (rc, body, req, reply, { params }) => verb(rc, { ...body, id: params.id }) })`. Names are unique and dotted. Every action-guarded route is covered automatically by `tests/api/contract.test.ts`.
6. **Page** `app/(app)/<area>/page.tsx` (server component): `const cur = await requirePage('module.view')`, call the query with `cur.rc.actor`, render with `src/ui`. Forms and buttons are small `'use client'` components that call `post()` from `src/ui/api.ts` and show a failure with reason, owner and next action (the `Blocked`/`Alert` components), then `router.refresh()`. Add the nav entry inside your marked block of `src/app-nav.ts`.
7. **Tests**: API-level tests with `tests/api/harness.ts` (import it first). Name acceptance tests after the SRS ids, e.g. `it('AT-029 archive is blocked with the dependencies listed', ...)`. Cover: the happy path, every refusal path, the audit row, 404 for out-of-scope, 403 for no grant, and one concurrency case where relevant.

Rules that are not negotiable: no deletes; timeouts never decide for a person; nothing OPEN hard-coded (use `getConfig` / the registry, add keys to the registry only if WP-0 owns them: report instead); notification failure never changes business state; end dates are departure days (D-103).

## 10. Exit gate result (14 Oct 2026)

Run on the merged branch against a real PostgreSQL 16, application connected as `app_role`:

| Check | Result |
|---|---|
| `tsc --noEmit`, `next lint`, `next build` | clean |
| Vitest (28 files) | 537 passed, 0 failed |
| Acceptance tests by name | AT-001, 002, 003, 004, 005, 028, 029 each have API-level tests (`grep -r "AT-0" platform/tests/api`) |
| Permission contract test | green; every route declares access, every policy-guarded route is checked for every role |
| Playwright smoke | 11 passed (auth, property, staff, access) |
| Severity-1 defects | none known |

**Not in Stage 1 (carried forward):** room/building blocking (D-19), site archive, D-03 re-confirmation, reassigning pending requests when a maker is deactivated, a `reply.file` option in `route()` for downloads, a shared `Problem` and `LinkButton` in the UI kit. Open questions S-8 to S-11 in `docs/PLAN.md` need the product owner.
