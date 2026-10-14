-- WP-B: staff CSV import. A batch is created by PREVIEW (nothing is written to staff_profile) and becomes
-- 'confirmed' exactly once. Valid rows are saved once (AT-005): a staff profile can come from at most one import row,
-- and a decided row can never be decided again.

CREATE TABLE import_batch (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff')),
  status          text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'confirmed')),
  file_name       text,
  created_by      uuid NOT NULL REFERENCES user_account (id),
  total_rows      integer NOT NULL CHECK (total_rows >= 0),
  new_rows        integer NOT NULL CHECK (new_rows >= 0),
  duplicate_rows  integer NOT NULL CHECK (duplicate_rows >= 0),
  invalid_rows    integer NOT NULL CHECK (invalid_rows >= 0),
  warning_rows    integer NOT NULL CHECK (warning_rows >= 0),
  ignored_columns text[] NOT NULL DEFAULT '{}',
  -- set at confirm
  policy          text CHECK (policy IN ('save_valid', 'all_or_nothing')),
  created_count   integer CHECK (created_count >= 0),
  rejected_count  integer CHECK (rejected_count >= 0),
  confirmed_by    uuid REFERENCES user_account (id),
  confirmed_at    timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batch_counts CHECK (new_rows + duplicate_rows + invalid_rows = total_rows),
  CONSTRAINT import_batch_confirmed_consistent CHECK (
    (status = 'previewed' AND confirmed_at IS NULL AND created_count IS NULL)
    OR (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND created_count IS NOT NULL
        AND rejected_count IS NOT NULL AND created_count + rejected_count = total_rows)
  )
);
CREATE INDEX import_batch_created_by_idx ON import_batch (created_by, created_at DESC);

CREATE TABLE import_row (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES import_batch (id),
  row_no          integer NOT NULL CHECK (row_no >= 2),          -- spreadsheet row: the header is row 1
  raw             jsonb NOT NULL,                                -- what the file said (cells shortened), by canonical column
  data            jsonb,                                         -- normalised values; set only for classification 'new'
  employee_key    text,                                          -- lower(btrim(employee_id)); null when the cell was unusable
  classification  text NOT NULL CHECK (classification IN ('new', 'duplicate', 'invalid')),
  reasons         text[] NOT NULL DEFAULT '{}',
  warnings        text[] NOT NULL DEFAULT '{}',
  outcome         text CHECK (outcome IN ('created', 'rejected')),   -- set once, at confirm
  outcome_reason  text,
  staff_id        uuid REFERENCES staff_profile (id),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_row_once UNIQUE (batch_id, row_no),
  CONSTRAINT import_row_new_has_data CHECK (classification <> 'new' OR data IS NOT NULL),
  CONSTRAINT import_row_created_has_staff CHECK ((outcome = 'created') = (staff_id IS NOT NULL))
);
-- A staff profile comes from at most one import row.
CREATE UNIQUE INDEX import_row_staff_once ON import_row (staff_id) WHERE staff_id IS NOT NULL;

-- Once confirmed, a batch and its decided rows are frozen: no second confirm can re-decide anything.
CREATE FUNCTION import_batch_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'import batch % is confirmed and cannot change', OLD.id USING ERRCODE = 'GH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_batch_freeze BEFORE UPDATE ON import_batch FOR EACH ROW EXECUTE FUNCTION import_batch_freeze();

CREATE FUNCTION import_row_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'import row % was already decided', OLD.id USING ERRCODE = 'GH001';
  END IF;
  IF NEW.batch_id <> OLD.batch_id OR NEW.row_no <> OLD.row_no OR NEW.raw <> OLD.raw OR NEW.classification <> OLD.classification THEN
    RAISE EXCEPTION 'import row % content is fixed once previewed', OLD.id USING ERRCODE = 'GH001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_row_freeze BEFORE UPDATE ON import_row FOR EACH ROW EXECUTE FUNCTION import_row_freeze();

GRANT SELECT, INSERT, UPDATE ON import_batch, import_row TO app_role;
