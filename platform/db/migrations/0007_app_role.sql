-- The application's database role. Production login roles are made members of app_role (see README);
-- tests do the same with a throwaway login. Migrations run as a different, privileged role.
--
-- Rules (CLAUDE.md): no deletion (archive only), the audit log is append-only, configuration is append-only.
-- Every table added by a later migration gets NO access until that migration grants it explicitly;
-- tests/db/app-role.test.ts fails the build if app_role ever holds DELETE/TRUNCATE on any table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;  -- another database on the same cluster created it concurrently
END $$;

GRANT USAGE ON SCHEMA public TO app_role;

-- Business tables: read, create, update. Never delete.
GRANT SELECT, INSERT, UPDATE ON
  site, building, room, bed,
  staff_profile, user_account, role_assignment, capability_grant, session, delegation,
  accommodation_request, bed_claim, reservation, stay, waitlist_entry, bed_offer
TO app_role;

-- Append-only tables: read and insert only.
GRANT SELECT, INSERT ON audit_event, config_item TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON config_item FROM app_role;

-- Reference data changes by migration only.
GRANT SELECT ON state_transition TO app_role;
