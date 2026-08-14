ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role varchar(16) NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin'));

ALTER TABLE invitation_codes
  ADD COLUMN IF NOT EXISTS granted_role varchar(16) NOT NULL DEFAULT 'member'
    CHECK (granted_role IN ('member', 'admin'));
