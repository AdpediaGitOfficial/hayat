-- Transition guards: the database refuses illegal state jumps even if application code has a bug (PLAN section 5.1).
-- The allowed moves are DATA (state_transition), enforced by one generic trigger, and mirrored by the pure
-- state machines in src/domain. tests/db/transitions.test.ts keeps the two in step.
--
-- Only UPDATEs are guarded. A row may be INSERTed in any valid state, because Import Current Occupancy
-- (migration) and seed data legitimately create beds that are already Occupied.

CREATE TABLE state_transition (
  entity     text NOT NULL,                              -- '<table>.<column>'
  from_state text NOT NULL,
  to_state   text NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity, from_state, to_state),
  CHECK (from_state <> to_state)
);

CREATE FUNCTION enforce_state_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entity text := TG_TABLE_NAME || '.' || TG_ARGV[0];
  old_val  text := to_jsonb(OLD) ->> TG_ARGV[0];
  new_val  text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF old_val IS NOT DISTINCT FROM new_val THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM state_transition t
    WHERE t.entity = v_entity AND t.from_state = old_val AND t.to_state = new_val
  ) THEN
    RAISE EXCEPTION 'illegal % transition: % -> %', v_entity, old_val, new_val
      USING ERRCODE = 'GH001', HINT = 'See state_transition for the allowed moves';
  END IF;
  RETURN NEW;
END $$;

-- Bed physical state (D-17, D-64). Occupied never jumps to Available; Available is reached only via Inspection Required.
-- Occupied beds cannot be blocked (residents are flagged, never auto-moved). Unblocking goes through cleaning.
INSERT INTO state_transition (entity, from_state, to_state, note) VALUES
  ('bed.state', 'available',           'occupied',            'check-in'),
  ('bed.state', 'available',           'blocked',             NULL),
  ('bed.state', 'available',           'under_maintenance',   NULL),
  ('bed.state', 'available',           'archived',            'archive, never delete'),
  ('bed.state', 'occupied',            'needs_cleaning',      'checkout'),
  ('bed.state', 'occupied',            'inspection_required', 'checkout when cleaning is already done'),
  ('bed.state', 'needs_cleaning',      'inspection_required', 'cleaning done'),
  ('bed.state', 'needs_cleaning',      'blocked',             NULL),
  ('bed.state', 'needs_cleaning',      'under_maintenance',   NULL),
  ('bed.state', 'inspection_required', 'available',           'final inspection passed'),
  ('bed.state', 'inspection_required', 'needs_cleaning',      'final inspection failed'),
  ('bed.state', 'inspection_required', 'blocked',             NULL),
  ('bed.state', 'inspection_required', 'under_maintenance',   NULL),
  ('bed.state', 'blocked',             'needs_cleaning',      'unblock: needs cleaning and inspection first'),
  ('bed.state', 'blocked',             'under_maintenance',   NULL),
  ('bed.state', 'blocked',             'archived',            NULL),
  ('bed.state', 'under_maintenance',   'needs_cleaning',      'work finished'),
  ('bed.state', 'under_maintenance',   'inspection_required', 'work finished'),
  ('bed.state', 'under_maintenance',   'blocked',             NULL);

-- Stay lifecycle. Checked out != clearance complete: 'closed' needs the clearance case to finish first.
INSERT INTO state_transition (entity, from_state, to_state, note) VALUES
  ('stay.status', 'provisional',        'active',             'emergency check-in approved'),
  ('stay.status', 'provisional',        'resolution_pending', 'emergency check-in rejected; human-managed resolution'),
  ('stay.status', 'provisional',        'checked_out',        NULL),
  ('stay.status', 'active',             'checked_out',        NULL),
  ('stay.status', 'resolution_pending', 'active',             'decision reversed by a Policy Approver'),
  ('stay.status', 'resolution_pending', 'checked_out',        NULL),
  ('stay.status', 'checked_out',        'closed',             'clearance complete');

-- Reservation lifecycle (SRS section 6). Terminal states stay terminal.
INSERT INTO state_transition (entity, from_state, to_state, note) VALUES
  ('reservation.status', 'reserved', 'checked_in', NULL),
  ('reservation.status', 'reserved', 'cancelled',  NULL),
  ('reservation.status', 'reserved', 'no_show',    NULL),
  ('reservation.status', 'reserved', 'expired',    NULL);

-- A claim is converted in place: offer hold -> reservation -> stay. It never goes backwards.
INSERT INTO state_transition (entity, from_state, to_state, note) VALUES
  ('bed_claim.kind', 'offer_hold',  'reservation', 'offer accepted'),
  ('bed_claim.kind', 'reservation', 'stay',        'check-in');

CREATE TRIGGER bed_state_guard         BEFORE UPDATE OF state  ON bed         FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('state');
CREATE TRIGGER stay_status_guard       BEFORE UPDATE OF status ON stay        FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('status');
CREATE TRIGGER reservation_status_guard BEFORE UPDATE OF status ON reservation FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('status');
CREATE TRIGGER bed_claim_kind_guard    BEFORE UPDATE OF kind   ON bed_claim   FOR EACH ROW EXECUTE FUNCTION enforce_state_transition('kind');
