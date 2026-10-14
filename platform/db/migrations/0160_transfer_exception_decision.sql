-- Hardening round, WP-N (S-21, P-10; PROPOSED, pending client sign-off): a Policy Approver may DECLINE the exception a transfer or swap
-- destination needs. A grant is an eligibility_exception row (transfer_request_id, migration 0140); a decline has to be remembered too, or
-- the same request would keep asking the Policy Approver. One row per decision, per person and bed, append-only (nothing is edited or deleted).
-- Bound to the bed it was decided for: when the Accommodation Admin of the destination site chooses another bed, the question is asked again.

CREATE TABLE transfer_exception_decision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id uuid NOT NULL REFERENCES transfer_request (id),
  staff_id            uuid NOT NULL REFERENCES staff_profile (id),     -- the person who would move
  bed_id              uuid NOT NULL REFERENCES bed (id),               -- the destination bed it was decided for
  site_id             uuid NOT NULL REFERENCES site (id),              -- the destination site (the scope of the decider)
  decision            text NOT NULL CHECK (decision IN ('declined')),
  reason              text NOT NULL CHECK (btrim(reason) <> ''),
  decided_by          uuid NOT NULL REFERENCES user_account (id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfer_exception_decision_idx ON transfer_exception_decision (transfer_request_id, staff_id, bed_id);

CREATE TRIGGER transfer_exception_decision_no_update BEFORE UPDATE OR DELETE ON transfer_exception_decision FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER transfer_exception_decision_no_truncate BEFORE TRUNCATE ON transfer_exception_decision FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

GRANT SELECT, INSERT ON transfer_exception_decision TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON transfer_exception_decision FROM app_role;
