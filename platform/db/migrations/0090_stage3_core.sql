-- Stage 3 core: attachments, keys and assets (handover items with an append-only event log), cleaning tasks.

-- Evidence files (waiver evidence, damage photos, failed inspections). The row is the record; the bytes live behind
-- AttachmentStore (local disk now). Never updated, never deleted.
CREATE TABLE attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id    uuid NOT NULL,
  site_id      uuid REFERENCES site (id),
  filename     text NOT NULL CHECK (btrim(filename) <> ''),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'application/pdf')),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key  text NOT NULL UNIQUE,
  uploaded_by  uuid NOT NULL REFERENCES user_account (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_entity_idx ON attachment (entity_type, entity_id);

-- Keys and assets handed to people. D-72 (key model for shared rooms) is OPEN, so item types are configuration and a
-- room key and a bed locker key are both just items linked to a room or a bed.
CREATE TABLE handover_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category        text NOT NULL CHECK (category IN ('key', 'asset')),
  item_type       text NOT NULL CHECK (btrim(item_type) <> ''),     -- 'room_key', 'locker_key', 'access_card', ...
  code            text NOT NULL CHECK (btrim(code) <> ''),          -- the tag or key number on the item
  site_id         uuid NOT NULL REFERENCES site (id),
  room_id         uuid REFERENCES room (id),
  bed_id          uuid REFERENCES bed (id),
  status          text NOT NULL DEFAULT 'in_cabinet' CHECK (status IN ('in_cabinet', 'issued', 'lost', 'damaged', 'retired')),
  holder_staff_id uuid REFERENCES staff_profile (id),
  issued_at       timestamptz,
  due_back        date,
  replaced_by     uuid REFERENCES handover_item (id),               -- the new item that replaced this retired one (D-73)
  note            text,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handover_holder_when_issued CHECK ((status = 'issued') = (holder_staff_id IS NOT NULL) OR status IN ('lost', 'damaged'))
);
CREATE UNIQUE INDEX handover_item_code_uq ON handover_item (site_id, category, lower(btrim(code))) WHERE archived_at IS NULL;
CREATE INDEX handover_item_holder_idx ON handover_item (holder_staff_id) WHERE holder_staff_id IS NOT NULL;
CREATE INDEX handover_item_bed_idx ON handover_item (bed_id) WHERE bed_id IS NOT NULL;
CREATE INDEX handover_item_room_idx ON handover_item (room_id) WHERE room_id IS NOT NULL;
CREATE TRIGGER handover_item_touch BEFORE UPDATE ON handover_item FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every movement of an item, append-only (a lost key is a fact, not an edit).
CREATE TABLE handover_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES handover_item (id),
  kind          text NOT NULL CHECK (kind IN ('issued', 'returned', 'lost', 'damaged', 'retired', 'replaced', 'found')),
  staff_id      uuid REFERENCES staff_profile (id),                 -- the person it concerns
  actor_user_id uuid REFERENCES user_account (id),
  on_behalf     boolean NOT NULL DEFAULT false,                     -- recorded for someone who is not present (former employee)
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handover_event_item_idx ON handover_event (item_id, created_at);
CREATE TRIGGER handover_event_no_update BEFORE UPDATE OR DELETE ON handover_event FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER handover_event_no_truncate BEFORE TRUNCATE ON handover_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- One cleaning task per bed at a time. A bed becomes Available only through a passed final inspection of its task.
CREATE TABLE cleaning_task (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bed_id              uuid NOT NULL REFERENCES bed (id),
  site_id             uuid NOT NULL REFERENCES site (id),
  reason              text NOT NULL CHECK (btrim(reason) <> ''),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleaned', 'passed', 'failed', 'cancelled')),
  assigned_to_staff   uuid REFERENCES staff_profile (id),
  assigned_by         uuid REFERENCES user_account (id),
  assigned_at         timestamptz,
  cleaned_by_staff    uuid REFERENCES staff_profile (id),
  cleaned_at          timestamptz,
  checklist           jsonb,
  inspected_by_staff  uuid REFERENCES staff_profile (id),
  inspected_by        uuid REFERENCES user_account (id),
  inspected_at        timestamptz,
  inspection_note     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cleaning_cleaner_not_inspector CHECK (cleaned_by_staff IS NULL OR inspected_by_staff IS NULL OR cleaned_by_staff <> inspected_by_staff)
);
CREATE UNIQUE INDEX one_open_cleaning_per_bed ON cleaning_task (bed_id) WHERE status IN ('open', 'cleaned');
CREATE INDEX cleaning_task_site_idx ON cleaning_task (site_id, status);
CREATE TRIGGER cleaning_task_touch BEFORE UPDATE ON cleaning_task FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON handover_item, cleaning_task TO app_role;
GRANT SELECT, INSERT ON attachment, handover_event TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON attachment FROM app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON handover_event FROM app_role;
