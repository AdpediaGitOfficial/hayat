-- Append-only tables: the audit log and versioned configuration.
-- Two layers: app_role has no UPDATE/DELETE/TRUNCATE (see 0008), and these triggers refuse the same
-- for every role including the owner, so a mistaken maintenance script cannot rewrite history either.

CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'GH002';
END $$;

CREATE TABLE audit_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigint GENERATED ALWAYS AS IDENTITY,    -- total order, independent of clock skew
  actor_user_id uuid REFERENCES user_account (id),      -- NULL for system actors (scheduler, migration)
  actor_role    text,
  action        text NOT NULL CHECK (btrim(action) <> ''),
  entity_type   text,
  entity_id     uuid,
  site_id       uuid REFERENCES site (id),              -- lets "Audit log: own sites" be scoped in the query
  reason        text,
  before        jsonb,
  after         jsonb,
  request_id    text,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX audit_event_seq_uq ON audit_event (seq);
CREATE INDEX audit_event_entity_idx ON audit_event (entity_type, entity_id);
CREATE INDEX audit_event_site_time_idx ON audit_event (site_id, created_at);

CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- Configuration is versioned: a change inserts a new version, it never edits the old one.
-- The current value of a key is the highest version for the (key, site) pair. OPEN decisions live here, never in code.
CREATE TABLE config_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL CHECK (btrim(key) <> ''),
  scope_site_id uuid REFERENCES site (id),              -- NULL = global
  version       integer NOT NULL CHECK (version >= 1),
  value         jsonb NOT NULL,
  decision_ref  text,                                   -- e.g. 'D-47'
  decision_status text CHECK (decision_status IN ('decided', 'default', 'open')),
  reason        text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES user_account (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX config_item_version_uq ON config_item (
  key, coalesce(scope_site_id, '00000000-0000-0000-0000-000000000000'::uuid), version
);

CREATE TRIGGER config_item_no_update BEFORE UPDATE OR DELETE ON config_item
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER config_item_no_truncate BEFORE TRUNCATE ON config_item
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();
