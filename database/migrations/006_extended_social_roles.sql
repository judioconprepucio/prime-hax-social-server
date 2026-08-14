ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'helper', 'developer', 'admin'));

ALTER TABLE invitation_codes DROP CONSTRAINT IF EXISTS invitation_codes_granted_role_check;
ALTER TABLE invitation_codes
  ADD CONSTRAINT invitation_codes_granted_role_check
  CHECK (granted_role IN ('member', 'helper', 'developer', 'admin'));
