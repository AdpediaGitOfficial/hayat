-- Stage 2, WP-F: requests that change a stay after check-in (extension, transfer and swap, voluntary checkout).
-- Each business object keeps its own status and decision columns (no generic approval table, STAGE-2 section 2).
-- Nothing here is ever deleted: a request ends in a final status and stays as history.

-- ---------------------------------------------------------------------------------------------------------------
-- Extension (D-57): within policy the Accommodation Admin decides, beyond policy the Policy Approver.
-- current_end / new_end are departure days (end-exclusive, D-103).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE extension_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id               uuid NOT NULL REFERENCES site (id),
  stay_id               uuid NOT NULL REFERENCES stay (id),
  staff_id              uuid NOT NULL REFERENCES staff_profile (id),
  requested_by          uuid REFERENCES user_account (id),
  requested_by_staff_id uuid REFERENCES staff_profile (id),
  current_end           date NOT NULL,
  new_end               date NOT NULL,
  added_days            integer NOT NULL CHECK (added_days > 0),
  beyond_policy         boolean NOT NULL DEFAULT false,
  reason                text,
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  -- what stood in the way when it was asked (the next booking on the bed) and the beds that could take the whole stay instead
  clash                 jsonb,
  decided_by            uuid REFERENCES user_account (id),
  decided_at            timestamptz,
  decision_reason       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extension_dates CHECK (new_end > current_end),
  CONSTRAINT extension_reason_beyond_policy CHECK (NOT beyond_policy OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT extension_decision_complete CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT extension_reject_reason CHECK (status <> 'rejected' OR (decision_reason IS NOT NULL AND btrim(decision_reason) <> ''))
);
CREATE UNIQUE INDEX one_open_extension_per_stay ON extension_request (stay_id) WHERE status = 'requested';
CREATE INDEX extension_request_site_idx ON extension_request (site_id, status);
CREATE INDEX extension_request_staff_idx ON extension_request (staff_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Transfer (one stay to another bed) and swap (two stays exchange beds in ONE atomic operation, D-61, D-62).
-- to_bed_id is NULL for "any suitable bed": the Accommodation Admin picks one when approving.
-- A swap needs both occupants' consent; the consent columns record who gave it and how.
-- 'failed' is the surviving record of an execution that could not be completed: nothing moved (AT-022).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE transfer_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('transfer', 'swap')),
  site_id               uuid NOT NULL REFERENCES site (id),
  stay_id               uuid NOT NULL REFERENCES stay (id),
  staff_id              uuid NOT NULL REFERENCES staff_profile (id),
  from_bed_id           uuid NOT NULL REFERENCES bed (id),
  to_bed_id             uuid REFERENCES bed (id),
  other_stay_id         uuid REFERENCES stay (id),
  other_staff_id        uuid REFERENCES staff_profile (id),
  reason                text NOT NULL CHECK (btrim(reason) <> ''),
  needed_by             date,
  linked_extension_id   uuid REFERENCES extension_request (id),
  status                text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'approved', 'rejected', 'executed', 'failed', 'cancelled')),
  requested_by          uuid REFERENCES user_account (id),
  requested_by_staff_id uuid REFERENCES staff_profile (id),
  -- swap consent: a = the first stay's occupant, b = the other stay's occupant
  consent_a_at          timestamptz,
  consent_a_by          uuid REFERENCES user_account (id),
  consent_a_via         text CHECK (consent_a_via IN ('in_app', 'in_person', 'phone', 'written')),
  consent_a_note        text,
  consent_b_at          timestamptz,
  consent_b_by          uuid REFERENCES user_account (id),
  consent_b_via         text CHECK (consent_b_via IN ('in_app', 'in_person', 'phone', 'written')),
  consent_b_note        text,
  decided_by            uuid REFERENCES user_account (id),
  decided_at            timestamptz,
  decision_reason       text,
  executed_by           uuid REFERENCES user_account (id),
  executed_at           timestamptz,
  new_claim_id          uuid,
  other_new_claim_id    uuid,
  failure_count         integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  failed_at             timestamptz,
  failure_reason        text,
  failure_detail        jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfer_swap_shape CHECK (
    (kind = 'swap' AND other_stay_id IS NOT NULL AND other_staff_id IS NOT NULL AND other_stay_id <> stay_id)
    OR (kind = 'transfer' AND other_stay_id IS NULL AND other_staff_id IS NULL)),
  CONSTRAINT transfer_destination_differs CHECK (to_bed_id IS NULL OR to_bed_id <> from_bed_id),
  CONSTRAINT transfer_decision_complete CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT transfer_executed_complete CHECK (status <> 'executed' OR (executed_by IS NOT NULL AND executed_at IS NOT NULL)),
  CONSTRAINT transfer_failed_complete CHECK (status <> 'failed' OR (failed_at IS NOT NULL AND failure_reason IS NOT NULL)),
  CONSTRAINT transfer_reject_reason CHECK (status <> 'rejected' OR (decision_reason IS NOT NULL AND btrim(decision_reason) <> ''))
);
-- A stay is part of at most one open (undecided or approved-but-not-executed) transfer or swap.
CREATE UNIQUE INDEX one_open_transfer_per_stay ON transfer_request (stay_id) WHERE status IN ('requested', 'approved');
CREATE UNIQUE INDEX one_open_transfer_per_other_stay ON transfer_request (other_stay_id) WHERE other_stay_id IS NOT NULL AND status IN ('requested', 'approved');
CREATE INDEX transfer_request_site_idx ON transfer_request (site_id, status);
CREATE INDEX transfer_request_staff_idx ON transfer_request (staff_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Voluntary checkout (D-63): the resident asks, Reception acknowledges within 1 business day and processes it.
-- No approval. Checkout is not clearance and not bed ready (D-64): this table knows nothing about keys or cleaning.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE checkout_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id             uuid NOT NULL REFERENCES site (id),
  stay_id             uuid NOT NULL REFERENCES stay (id),
  staff_id            uuid NOT NULL REFERENCES staff_profile (id),
  requested_by        uuid REFERENCES user_account (id),
  departure_date      date NOT NULL,
  note                text,
  status              text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'acknowledged', 'completed', 'cancelled')),
  acknowledged_by     uuid REFERENCES user_account (id),
  acknowledged_at     timestamptz,
  completed_by        uuid REFERENCES user_account (id),
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_ack_complete CHECK (status <> 'acknowledged' OR acknowledged_at IS NOT NULL),
  CONSTRAINT checkout_done_complete CHECK (status <> 'completed' OR (completed_by IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_checkout_per_stay ON checkout_request (stay_id) WHERE status IN ('requested', 'acknowledged');
CREATE INDEX checkout_request_site_idx ON checkout_request (site_id, status);
CREATE INDEX checkout_request_staff_idx ON checkout_request (staff_id);

CREATE TRIGGER extension_request_touch BEFORE UPDATE ON extension_request FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER transfer_request_touch  BEFORE UPDATE ON transfer_request  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER checkout_request_touch  BEFORE UPDATE ON checkout_request  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The no-show sweep looks at open reservations by expected arrival.
CREATE INDEX reservation_open_eta_idx ON reservation (eta) WHERE status = 'reserved';

GRANT SELECT, INSERT, UPDATE ON extension_request, transfer_request, checkout_request TO app_role;
