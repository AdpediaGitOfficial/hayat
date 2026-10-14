-- Stage 3, WP-K: transfers and swaps may cross sites (D-104, SRS 5.5 step 27).
--
-- transfer_request.site_id stays the SOURCE site (the site of the stay when it was raised; for a swap, the site of the first stay).
-- destination_site_id is the site the resident is moving INTO (for a swap, the site of the second stay). Same site = same value.
--
-- Two keys (D-104): a move needs the approval of an Accommodation Admin of the source site AND one of the destination site (the same
-- person may give both when they hold both sites). For a same-site request one decision gives both keys, so "approved" always means
-- "both keys are present". The columns record who gave each key and when; decided_by / decided_at stay the moment the LAST key was given.
-- A failed execution clears the destination key (and, for a swap, the source key too): the request goes back to waiting.

ALTER TABLE transfer_request
  ADD COLUMN destination_site_id      uuid REFERENCES site (id),
  ADD COLUMN source_approved_by       uuid REFERENCES user_account (id),
  ADD COLUMN source_approved_at       timestamptz,
  ADD COLUMN destination_approved_by  uuid REFERENCES user_account (id),
  ADD COLUMN destination_approved_at  timestamptz;

-- Everything that exists today is same-site, and what was approved was approved for both sides at once.
UPDATE transfer_request SET destination_site_id = site_id;
UPDATE transfer_request
   SET source_approved_by = decided_by, source_approved_at = decided_at,
       destination_approved_by = decided_by, destination_approved_at = decided_at
 WHERE status IN ('approved', 'executed') AND decided_by IS NOT NULL;

ALTER TABLE transfer_request ALTER COLUMN destination_site_id SET NOT NULL;

ALTER TABLE transfer_request
  ADD CONSTRAINT transfer_source_key_pair CHECK ((source_approved_by IS NULL) = (source_approved_at IS NULL)),
  ADD CONSTRAINT transfer_destination_key_pair CHECK ((destination_approved_by IS NULL) = (destination_approved_at IS NULL)),
  -- an approved (or executed) move always has both keys
  ADD CONSTRAINT transfer_approved_has_both_keys CHECK (
    status NOT IN ('approved', 'executed') OR (source_approved_at IS NOT NULL AND destination_approved_at IS NOT NULL));

CREATE INDEX transfer_request_destination_site_idx ON transfer_request (destination_site_id, status);

-- app_role already holds SELECT, INSERT, UPDATE on transfer_request (0070); the grant is repeated so this file stands on its own.
GRANT SELECT, INSERT, UPDATE ON transfer_request TO app_role;
