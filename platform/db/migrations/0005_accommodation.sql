-- Accommodation core. Request != Reservation != Stay (separate tables, separate state machines).
-- The BED is the allocation unit: every claim on a bed (reservation, offer hold, stay) is one row in bed_claim,
-- and the exclusion constraint there is the database-level guarantee behind "a bed never has two overlapping
-- active reservations or stays".

CREATE TABLE accommodation_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid NOT NULL REFERENCES staff_profile (id),
  submitted_by     uuid REFERENCES user_account (id),
  on_behalf        boolean NOT NULL DEFAULT false,
  arrival_date     date NOT NULL,
  end_date         date,                                 -- NULL = open-ended (permanent)
  stay_type        text NOT NULL CHECK (stay_type IN ('permanent', 'contract', 'trainee')),
  note             text,
  status           text NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('draft', 'submitted', 'pending_approval', 'approved', 'rejected', 'cancelled', 'waitlisted', 'closed')),
  decided_by       uuid REFERENCES user_account (id),
  decided_at       timestamptz,
  decision_reason  text,
  exception_by     uuid REFERENCES user_account (id),    -- Policy Approver who allowed a gender/grade exception
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_dates CHECK (end_date IS NULL OR end_date >= arrival_date)
);
CREATE INDEX accommodation_request_staff_idx ON accommodation_request (staff_id);
CREATE INDEX accommodation_request_status_idx ON accommodation_request (status);

-- One live claim = one bed for one date range. period is '[start, end+1)'; an open-ended stay has no upper bound.
-- A claim is "live" until released_at is set. Released claims stay as history (no deletion) and stop excluding.
CREATE TABLE bed_claim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id         uuid NOT NULL REFERENCES bed (id),
  kind           text NOT NULL CHECK (kind IN ('reservation', 'offer_hold', 'stay')),
  period         daterange NOT NULL,
  released_at    timestamptz,
  release_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, bed_id),                                   -- target for the composite FKs below
  CONSTRAINT claim_period_valid CHECK (NOT isempty(period) AND NOT lower_inf(period)),
  CONSTRAINT claim_release_has_time CHECK (release_reason IS NULL OR released_at IS NOT NULL),
  CONSTRAINT no_double_allocation EXCLUDE USING gist (bed_id WITH =, period WITH &&) WHERE (released_at IS NULL)
);
CREATE INDEX bed_claim_bed_idx ON bed_claim (bed_id);

CREATE TABLE reservation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid REFERENCES accommodation_request (id),
  staff_id          uuid NOT NULL REFERENCES staff_profile (id),
  bed_id            uuid NOT NULL,
  claim_id          uuid NOT NULL UNIQUE,                -- dates live on the claim's period; not duplicated here
  eta               timestamptz NOT NULL,                -- expected arrival; no-show clock starts here (D-58)
  status            text NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'checked_in', 'cancelled', 'no_show', 'expired')),
  source            text NOT NULL CHECK (source IN ('request', 'offer', 'bulk', 'migrated')),
  stay_type         text NOT NULL CHECK (stay_type IN ('permanent', 'contract', 'trainee')),
  no_show_extended  boolean NOT NULL DEFAULT false,
  cancel_reason     text,
  created_by        uuid REFERENCES user_account (id),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, bed_id) REFERENCES bed_claim (id, bed_id)
);
CREATE INDEX reservation_staff_idx ON reservation (staff_id);
CREATE INDEX reservation_bed_idx ON reservation (bed_id);

CREATE TABLE stay (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id       uuid NOT NULL REFERENCES staff_profile (id),
  bed_id         uuid NOT NULL,
  claim_id       uuid NOT NULL UNIQUE,
  reservation_id uuid UNIQUE REFERENCES reservation (id),  -- NULL for migrated and provisional stays
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('provisional', 'active', 'resolution_pending', 'checked_out', 'closed')),
  source         text NOT NULL DEFAULT 'standard' CHECK (source IN ('standard', 'migrated', 'provisional')),
  stay_type      text NOT NULL CHECK (stay_type IN ('permanent', 'contract', 'trainee')),
  checked_in_at  timestamptz NOT NULL DEFAULT now(),
  checked_out_at timestamptz,
  closed_at      timestamptz,                             -- clearance complete (checkout != clearance != bed ready)
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, bed_id) REFERENCES bed_claim (id, bed_id),
  CONSTRAINT stay_checkout_time CHECK (status NOT IN ('checked_out', 'closed') OR checked_out_at IS NOT NULL),
  CONSTRAINT stay_closed_time CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
-- "Active" here means the person still occupies a bed, so provisional and resolution-pending stays count too.
CREATE UNIQUE INDEX one_active_stay_per_staff ON stay (staff_id)
  WHERE status IN ('provisional', 'active', 'resolution_pending');
CREATE INDEX stay_bed_idx ON stay (bed_id);

CREATE TABLE waitlist_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff_profile (id),
  request_id    uuid REFERENCES accommodation_request (id),
  priority      text,
  queue_ts      timestamptz NOT NULL DEFAULT now(),       -- position in queue; 2nd decline resets it to the back
  expires_at    timestamptz NOT NULL,                     -- entry date + 15 days (D-47), configurable
  declines      integer NOT NULL DEFAULT 0 CHECK (declines >= 0),
  skip_bed_ids  uuid[] NOT NULL DEFAULT '{}',
  reminders_sent integer[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'closed')),
  close_reason  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_entry_queue_idx ON waitlist_entry (queue_ts) WHERE status = 'waiting';

CREATE TABLE bed_offer (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id             uuid NOT NULL REFERENCES staff_profile (id),
  waitlist_entry_id    uuid REFERENCES waitlist_entry (id),
  bed_id               uuid NOT NULL,
  claim_id             uuid NOT NULL UNIQUE,              -- the 'offer_hold' claim; becomes the reservation's claim on accept
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  delivered_at         timestamptz,                       -- 48h window runs from CONFIRMED delivery (D-49)
  delivered_via        text CHECK (delivered_via IN ('viewed', 'email', 'offline')),
  expires_at           timestamptz,
  follow_up_sent_at    timestamptz,                       -- Reception alerted when unseen at 24h (D-51)
  accepted_by          uuid REFERENCES user_account (id),
  accepted_on_behalf   boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claim_id, bed_id) REFERENCES bed_claim (id, bed_id),
  CONSTRAINT offer_delivery_consistent CHECK ((delivered_at IS NULL) = (delivered_via IS NULL))
);
CREATE UNIQUE INDEX one_active_offer_per_staff ON bed_offer (staff_id) WHERE status = 'pending';

CREATE TRIGGER accommodation_request_touch BEFORE UPDATE ON accommodation_request FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER reservation_touch   BEFORE UPDATE ON reservation   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER stay_touch          BEFORE UPDATE ON stay          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER waitlist_entry_touch BEFORE UPDATE ON waitlist_entry FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER bed_offer_touch     BEFORE UPDATE ON bed_offer     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
