-- Apply this migration to databases created with schema v1 before device-bound
-- refresh sessions were introduced.
ALTER TABLE refresh_sessions
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES trusted_devices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS refresh_sessions_device_active_idx
  ON refresh_sessions (device_id, expires_at)
  WHERE revoked_at IS NULL;
