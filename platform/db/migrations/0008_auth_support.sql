-- Stage 1 core: the acting mode of a session (S-2), password-change time, and sign-in attempts for lockout and rate limiting.

ALTER TABLE session ADD COLUMN active_role text
  CHECK (active_role IS NULL OR active_role IN ('SA', 'AA', 'Rec', 'Res', 'MC', 'Tech', 'Vend', 'Sec', 'Mgr', 'Aud'));

ALTER TABLE user_account ADD COLUMN password_changed_at timestamptz;

-- One row per sign-in attempt (append-only). The username is stored normalised and only as typed text: it may not exist.
CREATE TABLE login_attempt (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username_norm text NOT NULL,
  ip            inet,
  succeeded     boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempt_user_time_idx ON login_attempt (username_norm, created_at DESC);
CREATE INDEX login_attempt_ip_time_idx ON login_attempt (ip, created_at DESC);

GRANT SELECT, INSERT ON login_attempt TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON login_attempt FROM app_role;
