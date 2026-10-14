-- Hardening round for S-14, S-18 to S-22 (proposed policies, pending client sign-off; see docs/DECISIONS.md "Proposed policies").

-- P-03: every key or asset movement records whether it happened outside the key desk's office hours, whether or not the
-- office-hours rule is enforced (a fact for the audit trail, not a restriction).
ALTER TABLE handover_event ADD COLUMN after_hours boolean NOT NULL DEFAULT false;

-- P-10: a Policy Approver exception can be granted for one transfer (the destination fails the gender or grade rule).
ALTER TABLE eligibility_exception ADD COLUMN transfer_request_id uuid REFERENCES transfer_request (id);
CREATE INDEX eligibility_exception_transfer_idx ON eligibility_exception (transfer_request_id) WHERE transfer_request_id IS NOT NULL;
ALTER TABLE eligibility_exception ADD CONSTRAINT eligibility_exception_one_subject CHECK (request_id IS NULL OR transfer_request_id IS NULL);
