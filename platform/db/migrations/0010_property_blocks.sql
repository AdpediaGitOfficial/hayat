-- WP-A (Stage 1): property setup and inventory.
--
-- 1. bed_block: the history of blocks on a bed. bed.state = 'blocked' is the physical state (D-17); the reason, the optional
--    last blocked day ("until", D-103: block dates use the LAST blocked day, not the departure-day convention) and who blocked
--    it live here. At most one block is open per bed. A released block stays as history (no deletion).
-- 2. Two guards that make "archive never races a reservation" true in the database, not only in the command:
--      a. a bed cannot be archived while it carries a live claim (reservation, offer hold or stay),
--      b. a live claim cannot be created on an archived bed.
--    Both take row locks, so they serialise with the archive command's own FOR UPDATE locks.

CREATE TABLE bed_block (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id       uuid NOT NULL,
  site_id      uuid NOT NULL,                           -- denormalised from the bed so scope checks never need a join
  reason       text NOT NULL CHECK (btrim(reason) <> ''),
  until_date   date,                                    -- LAST blocked day (inclusive); NULL = until further notice
  blocked_by   uuid REFERENCES user_account (id),
  blocked_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  released_by  uuid REFERENCES user_account (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bed_id, site_id) REFERENCES bed (id, site_id),
  CONSTRAINT bed_block_release_consistent CHECK (released_by IS NULL OR released_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_open_block_per_bed ON bed_block (bed_id) WHERE released_at IS NULL;
CREATE INDEX bed_block_bed_idx ON bed_block (bed_id, blocked_at DESC);
CREATE INDEX bed_block_site_open_idx ON bed_block (site_id) WHERE released_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON bed_block TO app_role;

-- (a) archiving a bed with a live claim is refused by the database.
CREATE FUNCTION guard_bed_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bed_claim WHERE bed_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'bed % has a live reservation, offer hold or stay and cannot be archived', NEW.id
      USING ERRCODE = 'GH001', HINT = 'Release or move the claims first';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bed_archive_guard BEFORE UPDATE OF state ON bed
  FOR EACH ROW WHEN (NEW.state = 'archived' AND OLD.state IS DISTINCT FROM 'archived')
  EXECUTE FUNCTION guard_bed_archive();

-- (b) a live claim cannot be created on an archived bed. FOR SHARE conflicts with the archive command's FOR UPDATE, so
-- exactly one of "claim" and "archive" wins when they race; the loser sees the winner's committed result.
CREATE FUNCTION guard_claim_on_archived_bed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bed_state text;
BEGIN
  IF NEW.released_at IS NULL THEN
    SELECT state INTO bed_state FROM bed WHERE id = NEW.bed_id FOR SHARE;
    IF bed_state = 'archived' THEN
      RAISE EXCEPTION 'bed % is archived and cannot be reserved or occupied', NEW.bed_id
        USING ERRCODE = 'GH001', HINT = 'Pick another bed';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bed_claim_archived_guard BEFORE INSERT ON bed_claim
  FOR EACH ROW EXECUTE FUNCTION guard_claim_on_archived_bed();
