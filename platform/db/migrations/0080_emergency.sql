-- WP-G: emergency check-in (D-66 to D-69) and the generic owned task used for the relocation follow-up.
--
-- An emergency check-in is a PROVISIONAL stay (stay.status = 'provisional', source 'provisional') plus one case row here.
-- The case carries the approval: who started it, which route decides it (AA when Reception started it, PA when an AA did,
-- D-68), the 24 h deadline, the reminders and escalation level, and the decision. Nothing in this schema or in any timer
-- approves, rejects, moves or checks anyone out: only a person decides, and the database refuses a decision by the person
-- who started the case.

CREATE TABLE emergency_checkin (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_id               uuid NOT NULL UNIQUE REFERENCES stay (id),
  staff_id              uuid NOT NULL REFERENCES staff_profile (id),
  bed_id                uuid NOT NULL REFERENCES bed (id),
  site_id               uuid NOT NULL REFERENCES site (id),
  initiated_by          uuid NOT NULL REFERENCES user_account (id),
  initiated_by_staff_id uuid REFERENCES staff_profile (id),
  initiated_by_role     text NOT NULL CHECK (initiated_by_role IN ('SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud')),
  -- D-68: Reception-initiated goes to an Accommodation Admin, AA-initiated goes to a Policy Approver.
  approver_route        text NOT NULL CHECK (approver_route IN ('AA', 'PA')),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'converted')),
  reason                text NOT NULL CHECK (btrim(reason) <> ''),
  expected_days         integer CHECK (expected_days IS NULL OR expected_days > 0),
  -- Eligibility is the approver's call (D-66): the rules that would have failed at initiation, shown to the approver.
  eligibility_flags     jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadline_at           timestamptz NOT NULL,
  reminders             integer NOT NULL DEFAULT 0 CHECK (reminders >= 0),
  last_reminder_at      timestamptz,
  escalation            integer NOT NULL DEFAULT 0 CHECK (escalation BETWEEN 0 AND 2),
  escalated_at          timestamptz,
  decided_by            uuid REFERENCES user_account (id),
  decided_by_role       text,
  decided_via           text CHECK (decided_via IN ('AA', 'PolicyApprover', 'BackupApprover')),
  decided_at            timestamptz,
  decision_note         text,
  decision_flags        jsonb,
  converted_at          timestamptz,                    -- Mark as Left turned the pending case into the clearance case (D-36)
  conversion_note       text,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A decision has an author and a time; nothing else does.
  CONSTRAINT emergency_decision_shape CHECK (
    (status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_via IS NOT NULL)
  ),
  CONSTRAINT emergency_rejection_reason CHECK (status <> 'rejected' OR btrim(coalesce(decision_note, '')) <> ''),
  CONSTRAINT emergency_converted_time CHECK ((status = 'converted') = (converted_at IS NOT NULL)),
  -- D-26 / AT-017, enforced in the database as well as the API: the initiator never decides.
  CONSTRAINT emergency_initiator_not_approver CHECK (decided_by IS NULL OR decided_by <> initiated_by)
);
CREATE INDEX emergency_checkin_site_status_idx ON emergency_checkin (site_id, status, created_at DESC);
CREATE INDEX emergency_checkin_pending_idx ON emergency_checkin (deadline_at) WHERE status = 'pending';
CREATE INDEX emergency_checkin_staff_idx ON emergency_checkin (staff_id);
CREATE UNIQUE INDEX emergency_one_pending_per_staff ON emergency_checkin (staff_id) WHERE status = 'pending';

-- A decided case is final: pending moves to approved, rejected or converted, and never back.
CREATE FUNCTION emergency_checkin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'illegal emergency_checkin.status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'GH001', HINT = 'A decided emergency check-in is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER emergency_checkin_status_guard BEFORE UPDATE OF status ON emergency_checkin FOR EACH ROW EXECUTE FUNCTION emergency_checkin_guard();
CREATE TRIGGER emergency_checkin_touch BEFORE UPDATE ON emergency_checkin FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A generic task owned by a role at a site, with a deadline (D-69: the relocation or checkout follow-up after a rejection).
-- It is a to-do for a person. Completing it is a person's act; a missed deadline only reminds and escalates.
CREATE TABLE task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_role  text NOT NULL CHECK (owner_role IN ('SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud')),
  site_id     uuid NOT NULL REFERENCES site (id),
  title       text NOT NULL CHECK (btrim(title) <> ''),
  detail      text,
  ref_type    text,
  ref_id      uuid,
  due_at      timestamptz,
  done_at     timestamptz,
  done_by     uuid REFERENCES user_account (id),
  done_note   text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_done_shape CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX task_owner_open_idx ON task (owner_role, site_id, due_at) WHERE done_at IS NULL;
CREATE UNIQUE INDEX task_one_open_per_ref ON task (ref_type, ref_id) WHERE done_at IS NULL AND ref_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON emergency_checkin, task TO app_role;
