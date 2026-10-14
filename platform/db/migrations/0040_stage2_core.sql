-- Stage 2 core: site on requests and waitlist entries, in-app notifications with idempotent keys,
-- sweep run log, eligibility exceptions (Policy Approver), and the D-103 date rule on requests.

-- A request names the site it is for; scope (AA, Reception) comes from it. Nothing exists in production yet,
-- so NOT NULL needs no backfill. See docs/STAGE-2.md S-12.
ALTER TABLE accommodation_request ADD COLUMN site_id uuid NOT NULL REFERENCES site (id);
ALTER TABLE waitlist_entry ADD COLUMN site_id uuid NOT NULL REFERENCES site (id);
CREATE INDEX accommodation_request_site_status_idx ON accommodation_request (site_id, status);
CREATE INDEX waitlist_entry_site_idx ON waitlist_entry (site_id) WHERE status <> 'closed';

-- D-103: end = departure day, so it must be after arrival. A request may also be asked to change (D-57 style review).
ALTER TABLE accommodation_request DROP CONSTRAINT request_dates;
ALTER TABLE accommodation_request ADD CONSTRAINT request_dates CHECK (end_date IS NULL OR end_date > arrival_date);
ALTER TABLE accommodation_request DROP CONSTRAINT accommodation_request_status_check;
ALTER TABLE accommodation_request ADD CONSTRAINT accommodation_request_status_check
  CHECK (status IN ('draft', 'submitted', 'pending_approval', 'changes_requested', 'approved', 'rejected', 'cancelled', 'waitlisted', 'closed'));

-- In-app notifications (email is Stage 5: email_status stays 'pending'). The dedupe key makes a retried event
-- produce ONE notification (AT-030). A recipient is a person OR a role/capability at a site; never both.
CREATE TABLE notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key     text NOT NULL CHECK (btrim(dedupe_key) <> ''),
  kind           text NOT NULL CHECK (btrim(kind) <> ''),
  to_staff_id    uuid REFERENCES staff_profile (id),
  to_role        text CHECK (to_role IN (
                   'SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud',
                   'Housekeeping', 'FinalInspection', 'EmergencyCheckin', 'BuildingCreation', 'NightKeys',
                   'BackupApprover', 'PolicyApprover', 'OutageExport', 'StaffMaster')),
  site_id        uuid REFERENCES site (id),
  text           text NOT NULL CHECK (btrim(text) <> ''),
  ref_type       text,
  ref_id         uuid,
  critical       boolean NOT NULL DEFAULT false,
  email_status   text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed', 'not_applicable')),
  email_attempts integer NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_one_recipient CHECK ((to_staff_id IS NOT NULL) <> (to_role IS NOT NULL))
);
CREATE UNIQUE INDEX notification_dedupe_uq ON notification (dedupe_key);
CREATE INDEX notification_staff_idx ON notification (to_staff_id, created_at DESC) WHERE to_staff_id IS NOT NULL;
CREATE INDEX notification_role_idx ON notification (to_role, site_id, created_at DESC) WHERE to_role IS NOT NULL;

-- One row per sweep run: when, how long, what it did. Sweeps are idempotent; this is for operators.
CREATE TABLE sweep_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  summary     jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sweep_run_name_idx ON sweep_run (name, started_at DESC);

-- Policy Approver exceptions to the gender or grade rule (D-25). Reason and evidence are mandatory; every use is recorded.
CREATE TABLE eligibility_exception (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff_profile (id),
  kind        text NOT NULL CHECK (kind IN ('gender', 'grade')),
  site_id     uuid REFERENCES site (id),                 -- NULL = any site
  request_id  uuid REFERENCES accommodation_request (id),
  granted_by  uuid NOT NULL REFERENCES user_account (id),
  reason      text NOT NULL CHECK (btrim(reason) <> ''),
  evidence    text NOT NULL CHECK (btrim(evidence) <> ''),
  valid_until date,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_exception_staff_idx ON eligibility_exception (staff_id) WHERE revoked_at IS NULL;

CREATE TABLE eligibility_exception_use (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exception_id uuid NOT NULL REFERENCES eligibility_exception (id),
  used_for     text NOT NULL,                              -- e.g. 'reservation'
  used_ref     uuid,
  used_by      uuid REFERENCES user_account (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_exception_use_idx ON eligibility_exception_use (exception_id);

GRANT SELECT, INSERT, UPDATE ON notification, sweep_run, eligibility_exception TO app_role;
GRANT SELECT, INSERT ON eligibility_exception_use TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON eligibility_exception_use FROM app_role;
