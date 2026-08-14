ALTER TABLE users
  ADD COLUMN IF NOT EXISTS handle_display varchar(24);

UPDATE users
SET handle_display = handle::text
WHERE handle_display IS NULL;

ALTER TABLE users
  ALTER COLUMN handle_display SET NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_handle_display_check;

ALTER TABLE users
  ADD CONSTRAINT users_handle_display_check
  CHECK (handle_display ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,23}$');
