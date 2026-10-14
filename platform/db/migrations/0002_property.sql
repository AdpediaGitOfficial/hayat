-- Property hierarchy: Site -> [Building] -> [Floor] -> [Unit] -> Room -> Bed (PLAN section 5, D-12).
-- Building, floor and unit are NULLABLE on room, so a villa is simply Site -> Room -> Bed.
-- bed.state is the PHYSICAL state only (D-17); dated reservations live in bed_claim.
-- No deletion anywhere: archived_at is the only way out (CLAUDE.md invariant).

CREATE TABLE site (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (btrim(code) <> ''),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  kind        text NOT NULL DEFAULT 'other' CHECK (kind IN ('villa', 'apartment', 'other')),
  time_zone   text NOT NULL DEFAULT 'UTC',              -- timestamps are stored in UTC, shown in the site zone (G-01)
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX site_code_uq ON site (lower(btrim(code)));

CREATE TABLE building (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site (id),
  code        text NOT NULL CHECK (btrim(code) <> ''),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, site_id)                                  -- target for room's composite FK
);
CREATE UNIQUE INDEX building_code_uq ON building (site_id, lower(btrim(code)));

CREATE TABLE room (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES site (id),
  building_id     uuid,                                 -- NULL for villas
  floor           text,                                 -- optional level
  unit            text,                                 -- optional unit / apartment
  name            text NOT NULL CHECK (btrim(name) <> ''),
  gender_policy   text NOT NULL DEFAULT 'any' CHECK (gender_policy IN ('any', 'male', 'female')),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, site_id),
  -- A room's building must belong to the room's site. MATCH SIMPLE: skipped when building_id IS NULL.
  FOREIGN KEY (building_id, site_id) REFERENCES building (id, site_id)
);
CREATE UNIQUE INDEX room_name_uq ON room (
  site_id,
  coalesce(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(lower(btrim(floor)), ''),
  coalesce(lower(btrim(unit)), ''),
  lower(btrim(name))
);

CREATE TABLE bed (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL,                           -- denormalised from room so scope checks never need a join
  room_id      uuid NOT NULL,
  code         text NOT NULL CHECK (btrim(code) <> ''),
  state        text NOT NULL DEFAULT 'available'
               CHECK (state IN ('available', 'occupied', 'needs_cleaning', 'inspection_required', 'blocked', 'under_maintenance', 'archived')),
  state_reason text,                                    -- why blocked / under maintenance
  state_since  timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, site_id),
  FOREIGN KEY (room_id, site_id) REFERENCES room (id, site_id),
  CONSTRAINT bed_archive_consistent CHECK ((state = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX bed_code_uq ON bed (site_id, lower(btrim(code)));
CREATE INDEX bed_room_idx ON bed (room_id);

CREATE TRIGGER site_touch     BEFORE UPDATE ON site     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER building_touch BEFORE UPDATE ON building FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER room_touch     BEFORE UPDATE ON room     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER bed_touch      BEFORE UPDATE ON bed      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
