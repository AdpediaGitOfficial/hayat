# Grand Hyatt Staff Accommodation Platform: production app

Stage 0 (decisions and foundation) and the Stage 1 core (`docs/STAGE-1.md`) of `docs/PLAN.md` section 13. Next.js 14 (App Router) + React 18 + TypeScript (strict) on PostgreSQL 16 (D-101, D-102). The clickable prototype in `../prototype` is a separate project and is not touched by this one.

Source of truth for behaviour: `../docs/DECISIONS.md`, then `../docs/PERMISSIONS.md`, `../docs/APPROVALS.md`, `../docs/PLAN.md`.

## Run it locally

Requirements: Node 22+, PostgreSQL 16 with the `btree_gist` extension (the standard `postgres:16` image and the Ubuntu/Debian `postgresql-16` packages both include it).

```bash
cd platform
cp .env.example .env            # then edit DATABASE_URL / TEST_DATABASE_ADMIN_URL for your server
npm ci
createdb gh_platform            # or any empty database named in DATABASE_URL
npm run db:migrate              # applies db/migrations/*.sql, safe to re-run
npm run dev                     # http://localhost:3000   and   http://localhost:3000/api/health
```

To run it on a server, see `../docs/DEPLOYMENT.md`.

### The full local check (what CI runs)

```bash
npm ci && npm run typecheck && npm run lint && npm run db:migrate && npm test && npm run build
```

`npm test` needs a PostgreSQL **superuser** connection in `TEST_DATABASE_ADMIN_URL` (default `postgres://postgres@localhost:5432/postgres`). It creates a throwaway database `gh_platform_test_<random>` and a throwaway login role, migrates the real SQL files into it, runs every test against that real server (no mocks), and drops both afterwards. It never touches `DATABASE_URL` or any other database.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | `next lint` over `app`, `src`, `tests`, `scripts` |
| `npm run db:migrate` | Applies pending migrations to `DATABASE_URL` |
| `npm test` | Vitest: domain, policy, database constraint and HTTP-level API tests (real PostgreSQL) |
| `npm run db:seed` | Demo sites and one user per role (username = employee ID; password `Welcome-GH-2026` or `SEED_PASSWORD`). Refuses to run in production |
| `npm run db:first-admin` | Creates the first Super Admin on a new installation (env: `ADMIN_EMPLOYEE_ID`, `ADMIN_NAME`, `ADMIN_PASSWORD`; owner role; refuses if one exists) |
| `npm run e2e` | Playwright browser smoke tests. `npm run build` first; creates and drops its own database, starts the server on port 3120. Set `E2E_CHROMIUM` for a browser installed elsewhere |

## Layout (PLAN section 4)

```
app/                    Next.js routes: home page, GET /api/health
src/domain/             pure rules, no I/O (ported from the prototype), enums, state machines, time helpers
src/server/             policy (permissions), clock, db (client, Drizzle schema, migration runner)
src/styles/tokens.css   design tokens copied from the prototype; screens arrive in Stage 1
src/ui/                 design-system components (empty until Stage 1)
db/migrations/          numbered SQL migrations: the source of truth for the schema
scripts/migrate.ts      CLI wrapper around the migration runner
tests/domain/           unit tests for the pure rules, time, state machines
tests/server/           policy tests, including the PERMISSIONS.md mirror test
tests/db/               constraint tests against a real PostgreSQL
.env.example
```

## What Stage 0 contains

- **Scaffold**: Next.js 14.2, React 18, strict TypeScript, ESLint (`next lint`), Vitest. Minimal UI: a home page and `GET /api/health` (200 with latency when the database answers, 503 `degraded` when it does not).
- **Schema v0** (`db/migrations`, numbered, each file in its own transaction, checksummed, advisory-locked):
  - `0002` property: `site`, `building`, `room`, `bed`. Floor and unit are nullable columns on `room`; building is nullable too, so a villa is Site -> Room -> Bed. `bed.state` is the physical state only (D-17).
  - `0003` people and access: `staff_profile` (uuid key, unique index on `lower(btrim(employee_id))`), `user_account`, `role_assignment` (role + scope), `capability_grant` (reason, expiry, maker, checker), `session` (DB-backed, revocation is a row update), `delegation`.
  - `0004` `audit_event` and `config_item` (versioned), both append-only.
  - `0005` accommodation core: `accommodation_request`, `reservation`, `stay`, `waitlist_entry`, `bed_offer`, and **`bed_claim`**.
  - `0006` transition guards: a `state_transition` table plus one generic trigger, applied to `bed.state`, `stay.status`, `reservation.status`, `bed_claim.kind`.
  - `0007` `app_role`: created idempotently, INSERT/SELECT/UPDATE on business tables, INSERT/SELECT only on `audit_event` and `config_item`, SELECT only on `state_transition`, **no DELETE or TRUNCATE anywhere**.
- **The invariants, enforced by the database** (each has tests in `tests/db`):
  - `bed_claim` has `EXCLUDE USING gist (bed_id WITH =, period WITH &&) WHERE (released_at IS NULL)`. One row per live claim on a bed (reservation, offer hold or stay); `period` is `[start, end+1)` and open-ended stays have no upper bound. Two concurrent transactions inserting overlapping claims: exactly one commits.
  - Reservation and stay stay separate records; both reference their claim through a composite foreign key `(claim_id, bed_id)`, so they cannot point at a claim on a different bed. Check-in converts the reservation's claim into the stay's claim in place (`kind` `reservation` -> `stay`) in one transaction, and a failure rolls the whole check-in back.
  - Partial unique indexes: `one_active_stay_per_staff`, `one_active_offer_per_staff`.
  - Illegal jumps are rejected with SQLSTATE `GH001` (for example a bed cannot go Occupied -> Available; the only way back is Needs Cleaning -> Inspection Required -> Available).
  - Audit and configuration are append-only for **every** role, including the owner: SQLSTATE `GH002`. Additionally `app_role` has no UPDATE/DELETE/TRUNCATE on them at the privilege level.
  - No deletion: `app_role` has no DELETE or TRUNCATE on any table; `archived_at` is the way out. A catalogue test checks every table in the schema, so a future migration that forgets this fails the build.
- **Policy module** `src/server/policy.ts`: deny-by-default `can(actor, action, resource?)`, `decide()` (tells "not allowed" from "out of scope", for 404 vs 403), `scopeFilter()` for list queries and exports. Table is Module x Action x Scope and mirrors `docs/PERMISSIONS.md`; a test parses that file and fails if a module is missing or a role marked "—" holds anything in it.
- **Injectable clock** `src/server/clock.ts` (`Clock`, `systemClock`, `FixedClock`), and the pure date/time helpers in `src/domain/time.ts`.
- **Domain port**: the prototype's React-free rules (eligibility, bed conflict/overlap windows, approval clock, stay state, separation-of-duties check) in `src/domain/`, with their types. The prototype's in-memory store and its permission tables were not ported (the policy module replaces the latter).
- **CI**: `.github/workflows/ci.yml` with `platform` and `prototype` jobs. Deployment is without containers: `docs/DEPLOYMENT.md`.

## Stage 1 core (WP-0)

How a request becomes an action, in the order it happens:

1. **`route({...})`** (`src/server/http.ts`) wraps every API handler. It checks same-origin (CSRF), resolves the session cookie to an acting identity, applies the "change your password first" restriction, checks the declared policy action, validates the JSON body with Zod, and turns a `Result` into JSON. `access` is mandatory (`public`, `authenticated` or a policy `action`), so a route cannot exist without saying who may call it.
2. **Sessions** (`src/server/auth/session.ts`): opaque 32-byte token in an HttpOnly, SameSite=Lax (Secure in production) cookie; only its SHA-256 is stored. Idle and absolute expiry come from configuration (staff roles 30 min / 12 h, residents 12 h / 7 d; placeholders, G-11). Revoking is an `UPDATE`; `revokeAllSessions()` is what Mark as Left will call.
3. **Actor** (`src/server/auth/actor.ts`): one active mode per session (S-2). `sites` is the union of the role's site assignments (`'all'` for a global one; building-scope gives none, S-6). `caps` are active, started, unexpired capability grants.
4. **`runCommand(rc, fn)`** (`src/server/command/run.ts`): one transaction per business action. A failure result or a throw rolls back everything, including the audit row. Known database errors (`23P01`, `40P01`, `23505`, `GH001`, `23503`, `23514`) become results, not 500s. `audit(c, {...})` writes inside the same transaction.
5. **Results** (`src/server/command/result.ts`): every refusal carries a `reason`, an `owner` and a `next` action (D-93). Out-of-scope reads answer 404 (AT-001/002); lacking the action answers 403.
6. **Configuration** (`src/server/config/registry.ts`): every tunable value with its default, type and decision reference (`getConfig(db, key, siteId?)`). Versions live in `config_item`; OPEN decisions are placeholders here, never hard-coded elsewhere.
7. **Pages**: server components call `requirePage(action?)` (`src/server/auth/page.ts`); navigation is `src/app-nav.ts`, filtered by the policy. UI components are in `src/ui` (`'use client'`; `src/ui/status.ts` is server-safe), browser calls go through `src/ui/api.ts`.

Sign-in refuses with one wording whether the username exists or not, and hashes either way. Five failures in 15 minutes lock the account (attempts made while locked are not recorded, so the lock cannot be extended or used as a denial of service), and one address is capped at four times that.

**Tests**: `tests/api/harness.ts` calls the real route handlers with real `Request` objects against the real database, connected as `app_role`. `tests/api/auth.test.ts` covers expiry, lockout, revocation, token hashing, CSRF, must-change and actor resolution. `tests/api/contract.test.ts` generates the permission contract from `POLICY` and the route files: every route declares access, and for every policy-guarded route and every role the API answers exactly what the policy says.

**Trusted proxy**: the client address comes from `X-Forwarded-For`/`X-Real-IP`. Run behind a proxy that overwrites those headers; it is used for rate limiting and the audit log only, never for authorization.

## Stage 2 core (allocation, notifications, sweeps, approvals)

`docs/STAGE-2.md` section 10 is the recipe. In short: **`allocateBed()`** (`src/server/allocation`) is the only way a bed gets a claim, and `claims.ts` the only file that writes `bed_claim` (a test enforces it); **`checkEligibility()`** (`src/server/eligibility`) runs the placeholder rules (GH-03 open) with Policy Approver exceptions; **`notify()`** (`src/server/notify`) writes in-app notifications with a unique dedupe key so retries and repeated sweeps notify once; **sweeps** (`src/server/jobs`) drive every timer, run via `npm run sweeps` or `POST /api/v1/internal/sweeps` with `INTERNAL_JOB_TOKEN`, and never decide for a person; **approval sources** (`src/server/approvals`) feed one inbox with SLA clock, escalation and separation-of-duties explanations.

## Stage 3 core (clearance and readiness)

`docs/STAGE-3.md` section 10 is the recipe. **`confirmPassword()`** (`src/server/auth/reauth.ts`) re-confirms the actor's password on high-risk actions (D-03), throttled like sign-in; **attachments** (`src/server/attachments`) store PNG, JPEG and PDF evidence (content sniffed, 5 MB, never deleted) behind a store interface (`ATTACHMENT_DIR`, default `./data/attachments`), the owning record's permission decides who sees a file; **`openCleaningTask()`** opens one cleaning task whenever a bed goes to Needs cleaning, and the only code that makes a bed Available is the passed final inspection (`src/server/commands/readiness/inspect.ts`, a test enforces it); **`closeStayIfDone()`** (`src/server/stays-close.ts`) closes a stay only when it is checked out, its clearance is Cleared and no key or asset is still held; keys and assets are `handover_item` rows with an append-only `handover_event` log (lost or damaged is never "returned").

## What Stage 0 does not contain

Background jobs (pg-boss), notifications, the clearance, key, cleaning, work-order, visitor and incident tables (Stages 2 to 4), the approval and transfer/extension/emergency tables (Stage 2), row-level security (optional second line of defence in PLAN section 6). (Stage 0 had no authentication, commands or screens; the Stage 1 core above adds them. pg-boss is decided, T-8, and arrives with the first background job.)

## Conventions worth knowing

- **Migrations are forward-only.** Never edit an applied file (the runner refuses and says so); add `NNNN_name.sql`. Every new table must `GRANT` explicitly to `app_role` (nothing is granted by default) and must have `created_at` and a uuid primary key.
- **The app connects as a member of `app_role`**, not as the migration owner. Example for a real deployment:
  `CREATE ROLE gh_app LOGIN PASSWORD '...' IN ROLE app_role;` then point `DATABASE_URL` at it, and run `db:migrate` with a privileged URL.
- **Values in the database are snake_case** (`needs_cleaning`, `checked_out`); the ported prototype types keep CamelCase (`NeedsCleaning`). `src/domain/enums.ts` holds the database values and a test keeps them equal to the CHECK constraints. The repository layer (Stage 1+) maps rows to the ported shapes.
- **Drizzle** (`src/server/db/schema.ts`) describes columns for typed queries. It does not generate the schema; `tests/db/schema-sync.test.ts` fails if it drifts from the migrated database.
- **Dates**: stored as UTC `timestamptz`; business dates (`date`, `daterange`) are plain calendar dates. Site time zone is a column on `site`, applied at display time.
- **Concurrent allocation**: the exclusion constraint guarantees one winner, but two transactions inserting at the same instant can end in `40P01` (deadlock) instead of `23P01` (exclusion violation). Commands therefore lock the bed row first (`SELECT ... FOR UPDATE`, PLAN section 7), which makes the loser fail cleanly with `23P01`; both codes mean "bed taken" and are mapped to the same blocked-state message. `tests/db/bed-claim.test.ts` covers both paths.
- **Known Next 14 advisories**: Next 14.2.35 is the last 14.x release and `npm audit` reports advisories only fixed in later majors (D-101 pins 14). The image optimiser is disabled in `next.config.mjs`; no rewrites or Edge server actions are used. Revisit the major version before Stage 6 (penetration test).
- Separation of duties (D-26) is **not** in the policy table because it needs the record being acted on. It runs inside each command after `can()`.
