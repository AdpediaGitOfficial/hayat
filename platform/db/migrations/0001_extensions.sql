-- Extensions and helpers shared by every later migration.

-- Needed for the bed_claim exclusion constraint (uuid equality + daterange overlap in one GiST index).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Keeps updated_at honest without relying on every writer to remember it.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
