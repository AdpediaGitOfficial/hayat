-- People and access: staff record, login account, role + scope, capability grants, sessions, delegation.

-- Staff profile: immutable uuid key. Employee ID is the unique BUSINESS key, normalised (trim + case-insensitive), D-05.
-- No auto-merge: a duplicate is rejected by the index below and surfaced to the admin.
CREATE TABLE staff_profile (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       text NOT NULL CHECK (btrim(employee_id) <> ''),
  full_name         text NOT NULL CHECK (btrim(full_name) <> ''),
  gender            text CHECK (gender IN ('male', 'female')),
  department        text,
  grade             integer CHECK (grade >= 0),
  phone             text,
  email             text,                               -- optional (D-06)
  emergency_contact text,
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'left')),
  joining_date      date,
  left_at           timestamptz,                        -- when Mark as Left was recorded
  left_effective    date,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'migration', 'seed')),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_left_consistent CHECK (employment_status = 'left' OR left_at IS NULL)
);
CREATE UNIQUE INDEX staff_employee_id_norm ON staff_profile (lower(btrim(employee_id)));

-- Login account. Username defaults to employee ID (D-06) but is its own unique value (contractors have no staff record).
CREATE TABLE user_account (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id              uuid UNIQUE REFERENCES staff_profile (id),
  username              text NOT NULL CHECK (btrim(username) <> ''),
  password_hash         text,                           -- Argon2id (T-3); NULL until activated
  must_change_password  boolean NOT NULL DEFAULT true,
  status                text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'locked', 'revoked')),
  failed_login_count    integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  revoked_at            timestamptz,                  -- Mark as Left sets this; sessions are revoked in the same transaction
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_username_uq ON user_account (lower(btrim(username)));

-- Role + scope. A user with several sites holds several rows. Only SA changes scope (D-22).
CREATE TABLE role_assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_account (id),
  role        text NOT NULL CHECK (role IN ('SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud')),
  scope_kind  text NOT NULL CHECK (scope_kind IN ('all', 'site', 'building', 'own', 'job')),
  site_id     uuid REFERENCES site (id),
  building_id uuid REFERENCES building (id),
  granted_by  uuid REFERENCES user_account (id),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_scope_shape CHECK (
    (scope_kind IN ('all', 'own', 'job') AND site_id IS NULL AND building_id IS NULL)
    OR (scope_kind = 'site' AND site_id IS NOT NULL AND building_id IS NULL)
    OR (scope_kind = 'building' AND building_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX role_assignment_active_uq ON role_assignment (
  user_id, role, scope_kind,
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(building_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE revoked_at IS NULL;
CREATE INDEX role_assignment_user_idx ON role_assignment (user_id) WHERE revoked_at IS NULL;

-- Capability grants add ACTIONS, never scope (D-22). Maker-checker (D-27): the checker is a different user.
CREATE TABLE capability_grant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES user_account (id),
  capability  text NOT NULL CHECK (capability IN
              ('Housekeeping', 'FinalInspection', 'EmergencyCheckin', 'BuildingCreation', 'NightKeys',
               'BackupApprover', 'PolicyApprover', 'OutageExport', 'StaffMaster')),
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'revoked')),
  maker_id    uuid NOT NULL REFERENCES user_account (id),
  checker_id  uuid REFERENCES user_account (id),
  decided_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_expiry_after_start CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT grant_maker_not_checker CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CONSTRAINT grant_active_needs_checker CHECK (status NOT IN ('active', 'rejected') OR (checker_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX capability_grant_user_idx ON capability_grant (user_id) WHERE status = 'active';

-- DB-backed sessions so that revoking a login is a row update (T-3). Only a hash of the token is stored.
CREATE TABLE session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES user_account (id),
  token_hash     text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  ip             inet,
  user_agent     text
);
CREATE INDEX session_live_user_idx ON session (user_id) WHERE revoked_at IS NULL;

-- Delegation of approval duties to a named stand-in for a date range (D-32).
CREATE TABLE delegation (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id uuid NOT NULL REFERENCES user_account (id),
  to_user_id   uuid NOT NULL REFERENCES user_account (id),
  starts_on    date NOT NULL,
  ends_on      date NOT NULL,
  reason       text,
  revoked_at   timestamptz,
  created_by   uuid REFERENCES user_account (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delegation_distinct CHECK (from_user_id <> to_user_id),
  CONSTRAINT delegation_range CHECK (ends_on >= starts_on)
);
CREATE INDEX delegation_to_idx ON delegation (to_user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER staff_profile_touch BEFORE UPDATE ON staff_profile FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER user_account_touch  BEFORE UPDATE ON user_account  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
