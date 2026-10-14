# Grand Hyatt Staff Accommodation Platform: production app

Stage 0 (decisions and foundation) of `docs/PLAN.md` section 13. Next.js 14 (App Router) + React 18 + TypeScript (strict) on PostgreSQL 16 (D-101, D-102). The clickable prototype in `../prototype` is a separate project and is not touched by this one.

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

Everything in one go, with containers (needs a Docker daemon):

```bash
cp .env.example .env            # set POSTGRES_PASSWORD
docker compose up --build       # postgres:16, one-shot migration, then the app on :3000
```

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
| `npm test` | Vitest: domain, policy and database constraint tests |

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
Dockerfile, docker-compose.yml, .env.example
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
- **Containers and CI**: multi-stage `Dockerfile` (Next `output: 'standalone'`, non-root, separate `migrate` target), `docker-compose.yml`, `.github/workflows/ci.yml` with `platform` and `prototype` jobs.

## What Stage 0 does not contain

Authentication and sessions logic (tables only), commands/repositories, any screen beyond the home page, background jobs (pg-boss), notifications, the clearance, key, cleaning, work-order, visitor and incident tables (Stages 2 to 4), the approval and transfer/extension/emergency tables (Stage 2), row-level security (optional second line of defence in PLAN section 6), and Playwright end-to-end tests. Argon2id, Zod and pg-boss are decided (T-3, T-5, T-8) but not installed yet; they arrive with the first code that uses them.

## Conventions worth knowing

- **Migrations are forward-only.** Never edit an applied file (the runner refuses and says so); add `NNNN_name.sql`. Every new table must `GRANT` explicitly to `app_role` (nothing is granted by default) and must have `created_at` and a uuid primary key.
- **The app connects as a member of `app_role`**, not as the migration owner. Example for a real deployment:
  `CREATE ROLE gh_app LOGIN PASSWORD '...' IN ROLE app_role;` then point `DATABASE_URL` at it, and run `db:migrate` with a privileged URL. The local `docker-compose.yml` uses the owner for simplicity.
- **Values in the database are snake_case** (`needs_cleaning`, `checked_out`); the ported prototype types keep CamelCase (`NeedsCleaning`). `src/domain/enums.ts` holds the database values and a test keeps them equal to the CHECK constraints. The repository layer (Stage 1+) maps rows to the ported shapes.
- **Drizzle** (`src/server/db/schema.ts`) describes columns for typed queries. It does not generate the schema; `tests/db/schema-sync.test.ts` fails if it drifts from the migrated database.
- **Dates**: stored as UTC `timestamptz`; business dates (`date`, `daterange`) are plain calendar dates. Site time zone is a column on `site`, applied at display time.
- **Concurrent allocation**: the exclusion constraint guarantees one winner, but two transactions inserting at the same instant can end in `40P01` (deadlock) instead of `23P01` (exclusion violation). Commands therefore lock the bed row first (`SELECT ... FOR UPDATE`, PLAN section 7), which makes the loser fail cleanly with `23P01`; both codes mean "bed taken" and are mapped to the same blocked-state message. `tests/db/bed-claim.test.ts` covers both paths.
- **Known Next 14 advisories**: Next 14.2.35 is the last 14.x release and `npm audit` reports advisories only fixed in later majors (D-101 pins 14). The image optimiser is disabled in `next.config.mjs`; no rewrites or Edge server actions are used. Revisit the major version before Stage 6 (penetration test).
- Separation of duties (D-26) is **not** in the policy table because it needs the record being acted on. It runs inside each command after `can()`.
