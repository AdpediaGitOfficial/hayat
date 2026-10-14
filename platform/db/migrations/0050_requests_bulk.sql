-- WP-D (Stage 2): the Policy Approver exception workflow and bulk allocation batches.
-- The request itself keeps its own status and decision columns (accommodation_request); these tables hold what does not fit there.

-- An Accommodation Admin asks a Policy Approver for a gender or grade exception on one request (D-25). The ask is the
-- "why" shown on the Policy Approver's card; the exception itself (eligibility_exception) is written when it is granted.
CREATE TABLE request_exception_ask (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES accommodation_request (id),
  site_id         uuid NOT NULL REFERENCES site (id),
  asked_by        uuid NOT NULL REFERENCES user_account (id),
  kinds           text[] NOT NULL DEFAULT '{}' CHECK (kinds <@ ARRAY['gender', 'grade']::text[]),
  bed_id          uuid REFERENCES bed (id),                 -- the bed the admin had in mind (information only)
  reason          text NOT NULL CHECK (btrim(reason) <> ''),
  status          text NOT NULL DEFAULT 'asked' CHECK (status IN ('asked', 'granted', 'declined', 'withdrawn')),
  decided_by      uuid REFERENCES user_account (id),
  decided_at      timestamptz,
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One open ask per request at a time.
CREATE UNIQUE INDEX request_exception_ask_open_uq ON request_exception_ask (request_id) WHERE status = 'asked';
CREATE INDEX request_exception_ask_request_idx ON request_exception_ask (request_id, created_at);
CREATE TRIGGER request_exception_ask_touch BEFORE UPDATE ON request_exception_ask FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Bulk allocation (D-60). A preview is a stored batch: nothing is reserved until it is confirmed. Confirming works row by
-- row (each row is its own transaction through the normal approval path), so a failed row leaves no trace and a second
-- confirm skips what is done and retries only what failed.
CREATE TABLE bulk_allocation_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES site (id),
  created_by   uuid NOT NULL REFERENCES user_account (id),
  status       text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'confirmed', 'partial', 'discarded')),
  confirmed_by uuid REFERENCES user_account (id),
  confirmed_at timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bulk_allocation_batch_site_idx ON bulk_allocation_batch (site_id, created_at DESC);
CREATE TRIGGER bulk_allocation_batch_touch BEFORE UPDATE ON bulk_allocation_batch FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE bulk_allocation_row (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES bulk_allocation_batch (id),
  position       integer NOT NULL CHECK (position >= 1),
  staff_id       uuid NOT NULL REFERENCES staff_profile (id),
  request_id     uuid REFERENCES accommodation_request (id),
  bed_id         uuid REFERENCES bed (id),
  arrival_date   date,
  end_date       date,
  stay_type      text CHECK (stay_type IN ('permanent', 'contract', 'trainee')),
  outcome        text NOT NULL CHECK (outcome IN ('new', 'conflict', 'not_eligible', 'no_request')),
  message        text NOT NULL DEFAULT '',                 -- what the preview said
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  result_message text,                                     -- what the confirm said
  reservation_id uuid REFERENCES reservation (id),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, position),
  CONSTRAINT bulk_row_done_has_reservation CHECK (status <> 'done' OR reservation_id IS NOT NULL)
);
CREATE INDEX bulk_allocation_row_request_idx ON bulk_allocation_row (request_id);
CREATE TRIGGER bulk_allocation_row_touch BEFORE UPDATE ON bulk_allocation_row FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON request_exception_ask, bulk_allocation_batch, bulk_allocation_row TO app_role;
