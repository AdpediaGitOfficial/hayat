-- Stage 3 WP-H: Mark as Left, clearance cases and bulk exit batches.
--
-- A clearance case is opened by Mark as Left (D-35) and stays open after the login is revoked (D-71): an authorised admin
-- works it on the former employee's behalf. Checkout, clearance complete and bed ready are three separate facts (D-64);
-- nothing here touches a stay or a bed.

CREATE TABLE clearance_case (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES staff_profile (id),
  stay_id        uuid REFERENCES stay (id),                   -- the stay flagged by the exit (live, or checked out and not yet closed)
  site_id        uuid REFERENCES site (id),                   -- the site of that stay or reservation; null when the person had neither (S-8)
  trigger_kind   text NOT NULL DEFAULT 'exit' CHECK (trigger_kind IN ('exit')),
  effective_date date NOT NULL,
  reason         text NOT NULL CHECK (btrim(reason) <> ''),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'pending_items', 'cleared')),
  opened_by      uuid NOT NULL REFERENCES user_account (id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  due_date       date NOT NULL,                               -- clearance.due_business_days after the day it was opened, site calendar
  cleared_by     uuid REFERENCES user_account (id),
  cleared_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clearance_cleared_shape CHECK ((status = 'cleared') = (cleared_at IS NOT NULL AND cleared_by IS NOT NULL))
);
-- One open case per person: a second exit for someone whose case is still open finds the existing one.
CREATE UNIQUE INDEX clearance_one_open_per_staff ON clearance_case (staff_id) WHERE status <> 'cleared';
CREATE INDEX clearance_case_staff_idx ON clearance_case (staff_id, opened_at DESC);
CREATE INDEX clearance_case_site_idx ON clearance_case (site_id, status, due_date);
CREATE INDEX clearance_case_stay_idx ON clearance_case (stay_id) WHERE stay_id IS NOT NULL;
CREATE TRIGGER clearance_case_touch BEFORE UPDATE ON clearance_case FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A cleared case is final: it never goes back to open (a new exit opens a new case).
CREATE FUNCTION clearance_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cleared' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.staff_id IS DISTINCT FROM OLD.staff_id) THEN
    RAISE EXCEPTION 'a cleared clearance case is final' USING ERRCODE = 'GH001', HINT = 'Open a new case with a new Mark as Left';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clearance_case_final BEFORE UPDATE ON clearance_case FOR EACH ROW EXECUTE FUNCTION clearance_case_guard();

CREATE TABLE clearance_item (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                uuid NOT NULL REFERENCES clearance_case (id),
  kind                   text NOT NULL CHECK (kind IN ('checklist', 'handover')),
  checklist_key          text,                                -- the id of the configured checklist entry
  handover_item_id       uuid REFERENCES handover_item (id),  -- a key or asset the person held; its state is read live
  label                  text NOT NULL CHECK (btrim(label) <> ''),
  mandatory              boolean NOT NULL,
  owner                  text NOT NULL CHECK (owner IN ('Reception', 'Maintenance', 'AA')),
  position               integer NOT NULL CHECK (position >= 1),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'waived', 'outstanding')),
  done_by                uuid REFERENCES user_account (id),
  done_at                timestamptz,
  on_behalf_of_staff_id  uuid REFERENCES staff_profile (id),  -- set when the actor is not the former employee (always, after revocation)
  note                   text,
  waived_by              uuid REFERENCES user_account (id),   -- Policy Approver only
  waived_at              timestamptz,
  waiver_reason          text,
  waiver_evidence        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clearance_item_kind_shape CHECK (
    (kind = 'checklist' AND checklist_key IS NOT NULL AND handover_item_id IS NULL) OR
    (kind = 'handover' AND handover_item_id IS NOT NULL AND checklist_key IS NULL)),
  CONSTRAINT clearance_item_done_shape CHECK (status <> 'done' OR (done_at IS NOT NULL)),
  CONSTRAINT clearance_item_waived_shape CHECK (status <> 'waived' OR
    (waived_by IS NOT NULL AND waived_at IS NOT NULL AND btrim(coalesce(waiver_reason, '')) <> '' AND btrim(coalesce(waiver_evidence, '')) <> ''))
);
CREATE UNIQUE INDEX clearance_item_checklist_uq ON clearance_item (case_id, checklist_key) WHERE kind = 'checklist';
CREATE UNIQUE INDEX clearance_item_handover_uq ON clearance_item (case_id, handover_item_id) WHERE kind = 'handover';
CREATE INDEX clearance_item_case_idx ON clearance_item (case_id, position);
CREATE INDEX clearance_item_handover_idx ON clearance_item (handover_item_id) WHERE handover_item_id IS NOT NULL;
CREATE TRIGGER clearance_item_touch BEFORE UPDATE ON clearance_item FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A waiver is final, and the items of a cleared case are frozen.
CREATE FUNCTION clearance_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'waived' AND NEW.status IS DISTINCT FROM 'waived' THEN
    RAISE EXCEPTION 'a waived clearance item cannot be reopened' USING ERRCODE = 'GH001', HINT = 'Only the Policy Approver decided this';
  END IF;
  IF (SELECT status FROM clearance_case WHERE id = OLD.case_id) = 'cleared' THEN
    RAISE EXCEPTION 'the items of a cleared clearance case are final' USING ERRCODE = 'GH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clearance_item_final BEFORE UPDATE ON clearance_item FOR EACH ROW EXECUTE FUNCTION clearance_item_guard();

-- Who did what and when (AT-020), append-only. The audit log carries the same facts; this is the case's own history.
CREATE TABLE clearance_event (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                   bigint GENERATED ALWAYS AS IDENTITY,        -- the order things happened in, even within one instant
  case_id               uuid NOT NULL REFERENCES clearance_case (id),
  item_id               uuid REFERENCES clearance_item (id),
  kind                  text NOT NULL CHECK (kind IN ('opened', 'item_added', 'item_done', 'item_reopened', 'item_outstanding', 'item_waived', 'item_synced', 'closed')),
  actor_user_id         uuid REFERENCES user_account (id),    -- null for a fact read from the keys register
  on_behalf_of_staff_id uuid REFERENCES staff_profile (id),
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clearance_event_case_idx ON clearance_event (case_id, created_at);
CREATE TRIGGER clearance_event_no_update BEFORE UPDATE OR DELETE ON clearance_event FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER clearance_event_no_truncate BEFORE TRUNCATE ON clearance_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- Bulk exit (D-38): a stored preview, then a confirm that works the rows one by one. Each row is its own transaction through
-- the same path a single Mark as Left takes, so a failed row leaves no trace and a second confirm only retries what failed.
CREATE TABLE exit_bulk_batch (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by     uuid NOT NULL REFERENCES user_account (id),
  effective_date date NOT NULL,
  reason         text NOT NULL CHECK (btrim(reason) <> ''),
  status         text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'confirmed', 'partial', 'discarded')),
  confirmed_by   uuid REFERENCES user_account (id),
  confirmed_at   timestamptz,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exit_bulk_batch_creator_idx ON exit_bulk_batch (created_by, created_at DESC);
CREATE TRIGGER exit_bulk_batch_touch BEFORE UPDATE ON exit_bulk_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE exit_bulk_row (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES exit_bulk_batch (id),
  position       integer NOT NULL CHECK (position >= 1),
  employee_id    text NOT NULL CHECK (btrim(employee_id) <> ''),   -- as typed
  staff_id       uuid REFERENCES staff_profile (id),
  outcome        text NOT NULL CHECK (outcome IN ('will_mark', 'already_left', 'not_found', 'blocked')),
  message        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  result_message text,
  case_id        uuid REFERENCES clearance_case (id),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, position),
  CONSTRAINT exit_bulk_row_done_has_case CHECK (status <> 'done' OR case_id IS NOT NULL)
);
CREATE TRIGGER exit_bulk_row_touch BEFORE UPDATE ON exit_bulk_row FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON clearance_case, clearance_item, exit_bulk_batch, exit_bulk_row TO app_role;
GRANT SELECT, INSERT ON clearance_event TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON clearance_event FROM app_role;
