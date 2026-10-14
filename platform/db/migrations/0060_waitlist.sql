-- WP-E: waitlist and bed offers (D-47 to D-53).
--
-- An entry remembers what the person asked for (arrival, optional end, stay type), because the bed offered to them is
-- held for exactly that window and becomes their reservation on accept. One live entry per person is a database rule.
-- Priority exceptions (Policy Approver, D-25 / D-53) are rows of their own, so the history of who asked, who decided
-- and why is kept even after the entry closes.

ALTER TABLE waitlist_entry
  ADD COLUMN arrival_date date NOT NULL,
  ADD COLUMN end_date     date,                         -- departure day (D-103); NULL = open-ended (permanent)
  ADD COLUMN stay_type    text NOT NULL CHECK (stay_type IN ('permanent', 'contract', 'trainee')),
  ADD COLUMN renewals     integer NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  ADD COLUMN on_behalf    boolean NOT NULL DEFAULT false,
  ADD COLUMN created_by   uuid REFERENCES user_account (id),
  ADD COLUMN closed_at    timestamptz,
  ADD CONSTRAINT waitlist_dates CHECK (end_date IS NULL OR end_date > arrival_date),
  ADD CONSTRAINT waitlist_closed_consistent CHECK ((status = 'closed') = (close_reason IS NOT NULL AND closed_at IS NOT NULL));

-- One live entry per person. A closed entry (expired, left, accepted) stays as history.
CREATE UNIQUE INDEX one_live_waitlist_entry_per_staff ON waitlist_entry (staff_id) WHERE status <> 'closed';
CREATE INDEX waitlist_entry_expiry_idx ON waitlist_entry (expires_at) WHERE status <> 'closed';

ALTER TABLE bed_offer
  ADD COLUMN created_by     uuid REFERENCES user_account (id),   -- the Accommodation Admin who chose the bed
  ADD COLUMN delivered_by   uuid REFERENCES user_account (id),   -- who recorded delivery (offline), NULL when the resident viewed it
  ADD COLUMN delivery_note  text,                                -- "informed offline" must say how and when (D-51)
  ADD COLUMN consent_note   text,                                -- accepted on behalf: the resident's consent (D-52)
  ADD COLUMN responded_at   timestamptz,
  ADD COLUMN response_note  text,                                -- decline reason, withdrawal reason, why it ended
  ADD CONSTRAINT offer_behalf_has_consent CHECK (NOT accepted_on_behalf OR (consent_note IS NOT NULL AND btrim(consent_note) <> ''));
CREATE INDEX bed_offer_open_idx ON bed_offer (expires_at, created_at) WHERE status = 'pending';

-- Waitlist priority exception: raised by an Accommodation Admin, decided by a Policy Approver (never the person
-- concerned, never the one who raised it). Reason and evidence are mandatory; the rows are the queue history.
CREATE TABLE waitlist_priority_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      uuid NOT NULL REFERENCES waitlist_entry (id),
  staff_id      uuid NOT NULL REFERENCES staff_profile (id),
  site_id       uuid NOT NULL REFERENCES site (id),
  category      text NOT NULL CHECK (btrim(category) <> ''),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  evidence      text NOT NULL CHECK (btrim(evidence) <> ''),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by  uuid NOT NULL REFERENCES user_account (id),
  decided_by    uuid REFERENCES user_account (id),
  decided_at    timestamptz,
  decision_note text,
  position_before integer,                                -- queue sequence when decided, for the history
  position_after  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT priority_decision_consistent CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_priority_per_entry ON waitlist_priority_request (entry_id) WHERE status = 'pending';
CREATE INDEX waitlist_priority_site_idx ON waitlist_priority_request (site_id, status);
CREATE TRIGGER waitlist_priority_request_touch BEFORE UPDATE ON waitlist_priority_request FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON waitlist_priority_request TO app_role;
