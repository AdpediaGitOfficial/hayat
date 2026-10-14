-- WP-C: user administration. Role changes by maker-checker (D-27), the home site of an account (so an
-- Accommodation Admin can manage "staff accounts in their own sites"), and database-level guards on the
-- decided states of grants and role-change requests.

-- A role or scope change is REQUESTED by one Super Admin and APPLIED only when a different one approves it.
-- The row is the record of that decision; the change itself lands in role_assignment in the approver's transaction.
CREATE TABLE role_change_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id         uuid NOT NULL REFERENCES user_account (id),
  kind                   text NOT NULL CHECK (kind IN ('add', 'remove')),
  role                   text NOT NULL CHECK (role IN ('SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud')),
  scope_kind             text NOT NULL CHECK (scope_kind IN ('all', 'site', 'building', 'own', 'job')),
  site_id                uuid REFERENCES site (id),
  building_id            uuid REFERENCES building (id),
  assignment_id          uuid REFERENCES role_assignment (id),   -- the assignment a 'remove' ends
  resulting_assignment_id uuid REFERENCES role_assignment (id),  -- the assignment an approved 'add' created
  reason                 text NOT NULL CHECK (btrim(reason) <> ''),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  maker_id               uuid NOT NULL REFERENCES user_account (id),
  checker_id             uuid REFERENCES user_account (id),
  decided_at             timestamptz,
  decision_note          text,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- the same shape rule as role_assignment
  CONSTRAINT role_change_scope_shape CHECK (
    (scope_kind IN ('all', 'own', 'job') AND site_id IS NULL AND building_id IS NULL)
    OR (scope_kind = 'site' AND site_id IS NOT NULL AND building_id IS NULL)
    OR (scope_kind = 'building' AND building_id IS NOT NULL)
  ),
  CONSTRAINT role_change_remove_needs_assignment CHECK (kind = 'add' OR assignment_id IS NOT NULL),
  -- D-27 / D-26: the checker is never the maker, and nobody approves a change to their own access
  CONSTRAINT role_change_maker_not_checker CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CONSTRAINT role_change_checker_not_target CHECK (checker_id IS NULL OR checker_id <> target_user_id),
  CONSTRAINT role_change_decided_needs_checker CHECK (
    status IN ('pending', 'cancelled') OR (checker_id IS NOT NULL AND decided_at IS NOT NULL)
  )
);
CREATE INDEX role_change_pending_idx ON role_change_request (created_at) WHERE status = 'pending';
CREATE INDEX role_change_target_idx ON role_change_request (target_user_id, created_at DESC);
-- One identical change waiting at a time.
CREATE UNIQUE INDEX role_change_pending_uq ON role_change_request (
  target_user_id, kind, role, scope_kind,
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(assignment_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE status = 'pending';
CREATE TRIGGER role_change_request_touch BEFORE UPDATE ON role_change_request FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The site an account was created for. Together with its site-scoped role assignments it defines which Accommodation
-- Admins may see and manage the account. (Once stays exist, the stay's site counts too: Stage 2.)
CREATE TABLE account_site (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_account (id),
  site_id     uuid NOT NULL REFERENCES site (id),
  created_by  uuid REFERENCES user_account (id),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_site_uq ON account_site (user_id, site_id) WHERE archived_at IS NULL;
CREATE INDEX account_site_site_idx ON account_site (site_id) WHERE archived_at IS NULL;

-- A decided request or grant is final. Rejected and revoked rows never become active again, whatever the application does.
CREATE FUNCTION guard_decided_access_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'capability_grant' THEN
    IF (OLD.status, NEW.status) IN (('pending', 'active'), ('pending', 'rejected'), ('pending', 'revoked'), ('active', 'revoked')) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'role_change_request' THEN
    IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'illegal %.status transition: % -> %', TG_TABLE_NAME, OLD.status, NEW.status
    USING ERRCODE = 'GH001', HINT = 'A decided request or grant is final; file a new one';
END $$;

CREATE TRIGGER capability_grant_status_guard    BEFORE UPDATE OF status ON capability_grant    FOR EACH ROW EXECUTE FUNCTION guard_decided_access_row();
CREATE TRIGGER role_change_request_status_guard BEFORE UPDATE OF status ON role_change_request FOR EACH ROW EXECUTE FUNCTION guard_decided_access_row();

-- No DELETE or TRUNCATE for the application role (tests/db/app-role.test.ts enforces this on every table).
GRANT SELECT, INSERT, UPDATE ON role_change_request, account_site TO app_role;
